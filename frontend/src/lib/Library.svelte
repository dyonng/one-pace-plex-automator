<script lang="ts">
  import {
    coverage,
    coverageLoading,
    runCoverageScan,
    metadataAudit,
    metadataAuditLoading,
    runMetadataAuditScan,
    doEpisodeAction,
    status,
    toast,
    refreshStatus,
  } from "./stores";
  import { fmtTime, fmtBytes, fmtAge } from "./util";
  import {
    fetchEpisodeMetadata,
    searchTorrents,
    postAction,
    type CoverageStatus,
    type CoverageEpisode,
    type EpisodeMetadata,
    type TorrentSearchResult,
    type MetadataState,
  } from "./api";

  let open = $state<Record<number, boolean>>({});
  const toggle = (part: number) => (open[part] = !open[part]);

  const CHIP: Record<CoverageStatus, string> = {
    present: "bg-success/20 text-success border-success/30",
    present_unknown: "bg-base-content/10 text-base-content/60 border-base-content/20",
    present_uncatalogued: "bg-success/10 text-success/70 border-success/30 border-dashed",
    upgradeable: "bg-warning/20 text-warning border-warning/40",
    downloading: "bg-accent/20 text-accent border-accent/40 animate-pulse",
    missing: "bg-error/10 text-error/80 border-error/30 border-dashed",
  };

  const CHIP_UPGRADEABLE_WITH_MAGNET = "bg-info/20 text-info border-info/40";

  const LABEL: Record<CoverageStatus, string> = {
    present: "present",
    present_unknown: "present (no CRC in name)",
    present_uncatalogued: "present (not in catalog yet)",
    upgradeable: "upgradeable",
    downloading: "downloading…",
    missing: "missing",
  };

  const META_LABEL: Record<MetadataState, string> = {
    ok: "up to date",
    missing: "metadata missing",
    drifted: "metadata drifted from dataset",
    not_in_plex: "not in Plex",
  };

  const pct = (n: number, d: number) => (d === 0 ? 0 : Math.round((n / d) * 100));

  // ── Metadata audit joined in by episode / arc ───────────────────────────────
  const metaByEp = $derived(
    new Map(($metadataAudit?.arcs ?? []).flatMap((a) => a.episodes).map((e) => [e.seasonEpisodeId, e]))
  );
  const metaByArc = $derived(new Map(($metadataAudit?.arcs ?? []).map((a) => [a.arcPart, a])));

  const flaggedCount = $derived(
    $metadataAudit
      ? $metadataAudit.totals.flagged + $metadataAudit.seasonsFlagged + $metadataAudit.totals.needsThumb
      : 0
  );

  const scanning = $derived($coverageLoading || $metadataAuditLoading);
  let syncing = $state(false);

  // One button, both scans: the disk-vs-catalog diff and the Plex metadata audit.
  async function scanAll() {
    await Promise.all([runCoverageScan(), runMetadataAuditScan()]);
  }

  // Reconcile: push flagged metadata + trigger thumbnail generation. The server
  // re-audits afterward and the status poll pulls the fresh report.
  async function syncFlagged() {
    syncing = true;
    try {
      const res = await postAction("metadata-sync");
      toast(res.message, res.ok);
    } catch {
      toast("Metadata reconcile failed", false);
    } finally {
      syncing = false;
      refreshStatus();
    }
  }

  let retryingThumbs = $state(false);

  // Reset attempt counters (incl. episodes written off as unavailable) and
  // re-request generation from Plex for everything still missing a thumbnail.
  async function retryThumbs() {
    retryingThumbs = true;
    try {
      const res = await postAction("retry-thumbs");
      toast(res.message, res.ok);
    } catch {
      toast("Thumbnail retry failed", false);
    } finally {
      retryingThumbs = false;
      refreshStatus();
    }
  }

  // Extra tooltip lines for a chip from the metadata audit, when it has findings.
  function metaLines(ep: CoverageEpisode): string {
    const m = metaByEp.get(ep.seasonEpisodeId);
    if (!m) return "";
    const lines: string[] = [];
    if (m.state === "missing" || m.state === "drifted") lines.push(META_LABEL[m.state]);
    if (m.thumbBlank) lines.push("blank thumbnail (single-color frame) — will regenerate");
    else if (m.needsThumb) lines.push("no thumbnail — will generate");
    if (m.thumbUnavailable) lines.push("no usable thumbnail — generation gave up");
    return lines.length ? "\n" + lines.join("\n") : "";
  }

  interface ModalState {
    ep: CoverageEpisode;
    view: "compare" | "search";
    // Compare view
    infoLoading: boolean;
    old: EpisodeMetadata | null;
    curr: EpisodeMetadata | null;
    upgrading: boolean;
    // Search view
    searchQuery: string;
    searching: boolean;
    searchResults: TorrentSearchResult[] | null;
    searchError: string | null;
    downloadingIdx: number | null;
  }

  let modal = $state<ModalState | null>(null);
  let dialogEl = $state<HTMLDialogElement | null>(null);

  $effect(() => {
    if (modal) dialogEl?.showModal();
    else dialogEl?.close();
  });

  const pipelineEp = $derived(
    modal
      ? ($status?.episodes ?? []).find(
          (e) => e.crc32.toUpperCase() === modal!.ep.datasetCrc32.toUpperCase()
        ) ?? null
      : null
  );

  async function openModal(ep: CoverageEpisode) {
    modal = {
      ep,
      view: "compare",
      infoLoading: true,
      old: null,
      curr: null,
      upgrading: false,
      searchQuery: ep.datasetCrc32,
      searching: false,
      searchResults: null,
      searchError: null,
      downloadingIdx: null,
    };
    const [oldMeta, currMeta] = await Promise.all([
      ep.diskCrc32 ? fetchEpisodeMetadata(ep.diskCrc32) : Promise.resolve(null),
      fetchEpisodeMetadata(ep.datasetCrc32),
    ]);
    if (modal) modal = { ...modal, infoLoading: false, old: oldMeta, curr: currMeta };
  }

  function closeModal() {
    modal = null;
  }

  async function doUpgrade() {
    if (!modal) return;
    modal = { ...modal, upgrading: true };
    try {
      const r = await doEpisodeAction(modal.ep.datasetCrc32, "upgrade");
      if (r.ok) closeModal();
    } finally {
      if (modal) modal = { ...modal, upgrading: false };
    }
  }

  function openSearch() {
    if (!modal) return;
    modal = { ...modal, view: "search" };
    doSearch();
  }

  async function doSearch() {
    if (!modal) return;
    modal = { ...modal, searching: true, searchResults: null, searchError: null };
    try {
      const results = await searchTorrents(modal.searchQuery);
      if (modal) modal = { ...modal, searching: false, searchResults: results };
    } catch (err) {
      if (modal) modal = { ...modal, searching: false, searchError: String(err) };
    }
  }

  function parseResolution(filename: string | null): string | null {
    if (!filename) return null;
    const m = filename.match(/\[(\d{3,4}p)\]/i);
    return m ? m[1] : null;
  }

  async function doDownloadSource(idx: number) {
    if (!modal) return;
    const result = modal.searchResults?.[idx];
    if (!result) return;
    const source = result.magnet ?? result.torrentUrl;
    if (!source) return;
    modal = { ...modal, downloadingIdx: idx };
    const r = await doEpisodeAction(modal.ep.datasetCrc32, "download-source", { source, title: result.title });
    if (r.ok) {
      closeModal();
    } else {
      if (modal) modal = { ...modal, downloadingIdx: null };
    }
  }

  // ── Batch upgrade modal ──────────────────────────────────────────────────────
  let batchOpen = $state(false);
  let batchDialogEl = $state<HTMLDialogElement | null>(null);
  let batchSelected = $state(new Set<string>());
  let batchUpgrading = $state(false);

  $effect(() => {
    if (batchOpen) batchDialogEl?.showModal();
    else batchDialogEl?.close();
  });

  const allUpgradeable = $derived(
    ($coverage?.arcs ?? []).flatMap(arc =>
      arc.episodes
        .filter(ep => ep.status === "upgradeable")
        .map(ep => ({ ...ep, arcTitle: arc.arcTitle }))
    )
  );

  // Split by whether a magnet link is available: link-ready episodes can be
  // upgraded automatically; no-link ones need manual attention.
  const upgradeNow = $derived(allUpgradeable.filter(ep => ep.hasMagnet));
  const cannotUpgrade = $derived(allUpgradeable.filter(ep => !ep.hasMagnet));

  const allSelected = $derived(
    upgradeNow.length > 0 &&
    upgradeNow.every(ep => batchSelected.has(ep.datasetCrc32))
  );

  const someSelected = $derived(
    upgradeNow.some(ep => batchSelected.has(ep.datasetCrc32))
  );

  function toggleAll() {
    if (allSelected) {
      batchSelected = new Set();
    } else {
      batchSelected = new Set(upgradeNow.map(ep => ep.datasetCrc32));
    }
  }

  function toggleOne(crc32: string) {
    const s = new Set(batchSelected);
    if (s.has(crc32)) s.delete(crc32); else s.add(crc32);
    batchSelected = s;
  }

  function openBatchModal() {
    batchSelected = new Set(upgradeNow.map(ep => ep.datasetCrc32));
    batchOpen = true;
  }

  function closeBatchModal() {
    batchOpen = false;
  }

  async function doBatchUpgrade() {
    if (batchSelected.size === 0) return;
    batchUpgrading = true;
    try {
      for (const crc32 of batchSelected) {
        await doEpisodeAction(crc32, "upgrade");
      }
      closeBatchModal();
    } finally {
      batchUpgrading = false;
    }
  }
</script>

<section class="deck-card card bg-base-100/60">
  <div class="card-body p-4 gap-4">
    <div class="flex items-center justify-between gap-3 flex-wrap">
      <div>
        <h2 class="eyebrow">Library</h2>
        <p class="text-xs opacity-60">
          Your media folder and Plex, diffed against the One Pace catalog — coverage, metadata, and thumbnails.
        </p>
      </div>
      <div class="flex gap-2">
        {#if $metadataAudit && ($metadataAudit.totals.needsThumb > 0 || $metadataAudit.totals.thumbUnavailable > 0)}
          <div
            class="tooltip tooltip-top before:max-w-xs before:whitespace-normal"
            data-tip="Asks Plex to generate a thumbnail again for every episode missing one — including those previous attempts gave up on. Generation runs in Plex's background queue, so results show up on a later scan."
          >
            <button
              class="btn btn-sm btn-outline btn-info"
              class:loading={retryingThumbs}
              disabled={retryingThumbs || syncing || scanning || $status?.busy}
              onclick={retryThumbs}
            >
              {retryingThumbs ? "Requesting…" : "Retry thumbnails"}
            </button>
          </div>
        {/if}
        {#if $metadataAudit}
          <div
            class="tooltip tooltip-top before:max-w-xs before:whitespace-normal"
            data-tip="Pushes the flagged missing/drifted metadata to Plex and triggers thumbnail generation for episodes missing one. Only touches what's flagged, not the whole library."
          >
            <button
              class="btn btn-sm {flaggedCount > 0 ? 'btn-warning' : 'btn-outline'}"
              class:loading={syncing}
              disabled={syncing || scanning || retryingThumbs || $status?.busy}
              onclick={syncFlagged}
            >
              {syncing ? "Reconciling…" : flaggedCount > 0 ? `Reconcile (${flaggedCount})` : "Reconcile"}
            </button>
          </div>
        {/if}
        <div
          class="tooltip tooltip-top before:max-w-xs before:whitespace-normal"
          data-tip="Scans your media folder for coverage (present / missing / upgradeable) and checks Plex for missing or drifted metadata and absent thumbnails. Read-only — makes no changes."
        >
          <button
            class="btn btn-sm btn-primary"
            class:loading={scanning}
            disabled={scanning || syncing || retryingThumbs || $status?.busy}
            onclick={scanAll}
          >
            {scanning ? "Scanning…" : $coverage || $metadataAudit ? "Re-scan" : "Scan library"}
          </button>
        </div>
      </div>
    </div>

    {#if $coverage || $metadataAudit}
      {#if $coverage && !$coverage.mediaPathExists}
        <div class="alert alert-warning text-sm">
          Media path <code class="font-mono">{$coverage.mediaPath}</code> not found — nothing to scan.
        </div>
      {/if}

      <!-- Totals -->
      <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
        {#if $coverage}
          {@const t = $coverage.totals}
          <div class="deck-card card bg-base-100/60">
            <div class="card-body p-3 gap-0.5">
              <span class="text-[0.65rem] uppercase tracking-wider opacity-60">Coverage</span>
              <span class="font-display text-2xl tabular-nums">{pct(t.present, t.episodes)}%</span>
              <span class="text-[0.65rem] opacity-50">{t.present} / {t.episodes} episodes</span>
            </div>
          </div>
          <div class="deck-card card bg-base-100/60">
            <div class="card-body p-3 gap-0.5">
              <span class="text-[0.65rem] uppercase tracking-wider opacity-60">Missing</span>
              <span class="font-display text-2xl tabular-nums text-error/80">{t.missing}</span>
              <span class="text-[0.65rem] opacity-50">not on disk</span>
            </div>
          </div>
          <button
            class="deck-card card bg-base-100/60 text-left transition-colors hover:bg-base-100/90 active:scale-[0.98] disabled:opacity-50 disabled:cursor-default"
            disabled={upgradeNow.length === 0}
            onclick={openBatchModal}
          >
            <div class="card-body p-3 gap-0.5">
              <span class="text-[0.65rem] uppercase tracking-wider opacity-60">Upgrade Now</span>
              <span class="font-display text-2xl tabular-nums text-info">{upgradeNow.length}</span>
              <span class="text-[0.65rem] opacity-50">link ready</span>
            </div>
          </button>
          <div class="deck-card card bg-base-100/60">
            <div class="card-body p-3 gap-0.5">
              <span class="text-[0.65rem] uppercase tracking-wider opacity-60">Cannot Upgrade</span>
              <span class="font-display text-2xl tabular-nums text-warning">{cannotUpgrade.length}</span>
              <span class="text-[0.65rem] opacity-50">no link yet</span>
            </div>
          </div>
        {/if}
        {#if $metadataAudit}
          {@const a = $metadataAudit.totals}
          <div class="deck-card card bg-base-100/60">
            <div class="card-body p-3 gap-0.5">
              <span class="text-[0.65rem] uppercase tracking-wider opacity-60">Metadata flagged</span>
              <span class="font-display text-2xl tabular-nums {a.flagged + $metadataAudit.seasonsFlagged > 0 ? 'text-warning' : 'text-success'}">
                {a.flagged + $metadataAudit.seasonsFlagged}
              </span>
              <span class="text-[0.65rem] opacity-50">
                {a.missing} missing · {a.drifted} drifted{$metadataAudit.seasonsFlagged ? ` · ${$metadataAudit.seasonsFlagged} season(s)` : ""}
              </span>
            </div>
          </div>
          <div class="deck-card card bg-base-100/60">
            <div class="card-body p-3 gap-0.5">
              <span class="text-[0.65rem] uppercase tracking-wider opacity-60">Missing thumbnails</span>
              <span class="font-display text-2xl tabular-nums {a.needsThumb > 0 ? 'text-info' : 'text-success'}">{a.needsThumb}</span>
              <span class="text-[0.65rem] opacity-50">
                {a.thumbUnavailable > 0 ? `${a.thumbUnavailable} unavailable` : "to generate"}
              </span>
            </div>
          </div>
        {/if}
      </div>

      {#if $coverage}
        <div class="flex flex-col gap-1.5">
          {#each $coverage.arcs as arc (arc.arcPart)}
            {@const complete = arc.missing === 0 && arc.upgradeable === 0 && arc.downloading === 0}
            {@const meta = metaByArc.get(arc.arcPart)}
            {@const metaFlagged = meta ? meta.missing + meta.drifted : 0}
            {@const seasonFlagged = meta ? meta.seasonState === "missing" || meta.seasonState === "drifted" : false}
            <div class="rounded-lg border border-base-content/10 bg-base-100/40">
              <button
                class="w-full flex items-center gap-3 px-3 py-2 hover:bg-base-content/5 text-left rounded-t-lg {open[arc.arcPart] ? '' : 'rounded-b-lg'}"
                title={arc.seasonFolder
                  ? `${$coverage.mediaPath}/${arc.seasonFolder}`
                  : "No season folder on disk yet"}
                onclick={() => toggle(arc.arcPart)}
              >
                <span class="opacity-40 text-xs w-3">{open[arc.arcPart] ? "▾" : "▸"}</span>
                <span class="font-mono text-xs opacity-50 tabular-nums">S{String(arc.arcPart).padStart(2, "0")}</span>
                <span class="flex-1 truncate text-sm">{arc.arcTitle}</span>
                {#if arc.upgradeable > 0}
                  <span class="badge badge-sm badge-warning">{arc.upgradeable} ↑</span>
                {/if}
                {#if arc.downloading > 0}
                  <span class="badge badge-sm badge-accent">{arc.downloading} ↓</span>
                {/if}
                {#if arc.missing > 0}
                  <span class="badge badge-sm badge-error badge-outline">{arc.missing} missing</span>
                {/if}
                {#if metaFlagged > 0 || seasonFlagged}
                  <span class="badge badge-sm badge-warning badge-outline">
                    {metaFlagged > 0 ? `${metaFlagged} meta` : "season meta"}
                  </span>
                {/if}
                {#if meta && meta.needsThumb > 0}
                  <span class="badge badge-sm badge-info badge-outline">{meta.needsThumb} thumb</span>
                {/if}
                {#if complete && metaFlagged === 0 && !seasonFlagged && (!meta || meta.needsThumb === 0)}
                  <span class="badge badge-sm badge-success badge-outline">complete</span>
                {/if}
                <span class="text-xs tabular-nums opacity-60 w-14 text-right">
                  {arc.present}/{arc.total}
                </span>
                <div class="hidden sm:block w-24">
                  <progress class="progress progress-success h-1.5" value={arc.present} max={arc.total}></progress>
                </div>
              </button>

              {#if open[arc.arcPart]}
                <div class="px-3 pb-3 pt-1 flex flex-wrap gap-1">
                  {#each arc.episodes as ep (ep.seasonEpisodeId)}
                    {@const m = metaByEp.get(ep.seasonEpisodeId)}
                    <div
                      class="tooltip before:max-w-xs before:whitespace-pre-line before:text-left"
                      data-tip={`E${ep.episodeNum} · ${ep.episodeTitle}\n${
                        ep.status === "upgradeable"
                          ? `${ep.extended ? "upgrade to Extended cut" : "upgradeable"}${ep.hasMagnet ? " · click to download" : " · no link yet"}\nClick to compare releases`
                          : LABEL[ep.status]
                      }${metaLines(ep)}${ep.diskFilename ? "\n" + ep.diskFilename : ""}`}
                    >
                      {#if ep.status === "upgradeable"}
                        <button
                          class="relative badge badge-sm border font-mono tabular-nums cursor-pointer {ep.hasMagnet ? CHIP_UPGRADEABLE_WITH_MAGNET : CHIP[ep.status]}"
                          onclick={() => openModal(ep)}
                        >
                          E{String(ep.episodeNum).padStart(2, "0")}
                          {#if m?.needsThumb}
                            <span class="absolute -top-1 -right-1 size-1.5 rounded-full bg-info"></span>
                          {:else if m?.thumbUnavailable}
                            <span class="absolute -top-1 -right-1 size-1.5 rounded-full bg-base-content/40"></span>
                          {/if}
                        </button>
                      {:else}
                        <span
                          class="relative badge badge-sm border font-mono tabular-nums {CHIP[ep.status]}"
                        >
                          E{String(ep.episodeNum).padStart(2, "0")}
                          {#if m?.needsThumb}
                            <span class="absolute -top-1 -right-1 size-1.5 rounded-full bg-info"></span>
                          {:else if m?.thumbUnavailable}
                            <span class="absolute -top-1 -right-1 size-1.5 rounded-full bg-base-content/40"></span>
                          {/if}
                        </span>
                      {/if}
                    </div>
                  {/each}
                </div>
              {/if}
            </div>
          {/each}
        </div>

        <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-[0.65rem] opacity-60">
          <span class="inline-flex items-center gap-1"><span class="size-2 rounded-sm bg-success/40"></span> present</span>
          <span class="inline-flex items-center gap-1"><span class="size-2 rounded-sm bg-info/50"></span> upgradeable (link ready)</span>
          <span class="inline-flex items-center gap-1"><span class="size-2 rounded-sm bg-warning/50"></span> upgradeable (no link)</span>
          <span class="inline-flex items-center gap-1"><span class="size-2 rounded-sm bg-accent/50"></span> downloading</span>
          <span class="inline-flex items-center gap-1"><span class="size-2 rounded-sm bg-error/40"></span> missing</span>
          <span class="inline-flex items-center gap-1"><span class="size-2 rounded-sm bg-base-content/20"></span> no CRC in name</span>
          <span class="inline-flex items-center gap-1"><span class="size-2 rounded-sm border border-dashed border-success/50"></span> not in catalog yet</span>
          <span class="inline-flex items-center gap-1"><span class="size-1.5 rounded-full bg-info"></span> no thumbnail</span>
        </div>

        {#if $coverage.extras.length > 0}
          <details class="text-xs">
            <summary class="cursor-pointer opacity-60 hover:opacity-100">
              {$coverage.extras.length} file(s) on disk not in the catalog
            </summary>
            <ul class="mt-2 pl-4 flex flex-col gap-0.5 font-mono opacity-60 max-h-40 overflow-y-auto">
              {#each $coverage.extras as f}
                <li class="truncate">{f}</li>
              {/each}
            </ul>
          </details>
        {/if}
      {/if}

      <p class="text-[0.65rem] opacity-40">
        {#if $coverage}Library scanned {fmtTime($coverage.scannedAt)}{/if}{#if $coverage && $metadataAudit} · {/if}{#if $metadataAudit}metadata audited {fmtTime($metadataAudit.scannedAt)}{/if}
      </p>
    {:else if !scanning}
      <p class="text-sm opacity-50">
        Run a scan to see which episodes you have, are missing, or can upgrade — and which are missing metadata or thumbnails in Plex.
      </p>
    {/if}
  </div>
</section>

{#snippet metaField(label: string, value: string, highlight: boolean = false, mono: boolean = false)}
  <div class="flex flex-col gap-0.5">
    <span class="text-[0.6rem] uppercase tracking-wider opacity-50">{label}</span>
    <span class="text-sm break-words {mono ? 'font-mono text-xs' : ''} {highlight ? 'text-warning font-medium' : ''}">{value || "—"}</span>
  </div>
{/snippet}

<!-- Batch upgrade modal -->
<dialog bind:this={batchDialogEl} class="modal" onclose={closeBatchModal}>
  <div class="modal-box max-w-4xl w-full">
    <button class="btn btn-sm btn-circle btn-ghost absolute right-2 top-2" onclick={closeBatchModal}>✕</button>
    <h3 class="font-bold text-base">Batch Upgrade</h3>
    <p class="text-xs opacity-50 mb-4">{upgradeNow.length} episode{upgradeNow.length === 1 ? "" : "s"} ready to upgrade</p>

    <div class="overflow-x-auto max-h-[60vh] rounded-box border border-base-content/10">
      <table class="table table-sm table-pin-rows">
        <thead>
          <tr class="text-xs uppercase tracking-wider">
            <th class="w-8">
              <input
                type="checkbox"
                class="checkbox checkbox-xs"
                checked={allSelected}
                indeterminate={someSelected && !allSelected}
                onchange={toggleAll}
                disabled={upgradeNow.length === 0}
              />
            </th>
            <th>Arc</th>
            <th>Ep</th>
            <th>Title</th>
            <th>Cut</th>
            <th class="font-mono">On Disk CRC32</th>
            <th class="font-mono">Latest CRC32</th>
          </tr>
        </thead>
        <tbody>
          {#each upgradeNow as ep (ep.datasetCrc32)}
            <tr class="hover:bg-base-200/40">
              <td>
                <input
                  type="checkbox"
                  class="checkbox checkbox-xs"
                  checked={batchSelected.has(ep.datasetCrc32)}
                  onchange={() => toggleOne(ep.datasetCrc32)}
                />
              </td>
              <td class="whitespace-nowrap">
                <span class="font-mono text-xs opacity-50">S{String(ep.arcPart).padStart(2, "0")}</span>
                <span class="text-xs ml-1">{ep.arcTitle}</span>
              </td>
              <td class="font-mono text-xs text-info">E{String(ep.episodeNum).padStart(2, "0")}</td>
              <td class="text-sm max-w-[16rem] truncate" title={ep.episodeTitle}>{ep.episodeTitle}</td>
              <td>
                {#if ep.extended}
                  <span class="badge badge-xs badge-info badge-outline">Extended</span>
                {:else}
                  <span class="text-xs opacity-50">Standard</span>
                {/if}
              </td>
              <td class="font-mono text-xs opacity-60">{ep.diskCrc32 ?? "—"}</td>
              <td class="font-mono text-xs text-info">{ep.datasetCrc32}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>

    <div class="modal-action">
      {#if batchUpgrading}
        <button class="btn btn-sm btn-info loading" disabled>Upgrading…</button>
      {:else}
        <button
          class="btn btn-sm btn-info"
          disabled={batchSelected.size === 0}
          onclick={doBatchUpgrade}
        >
          Update Selected ({batchSelected.size})
        </button>
      {/if}
      <button class="btn btn-sm btn-ghost" onclick={closeBatchModal}>Close</button>
    </div>
  </div>
  <form method="dialog" class="modal-backdrop"><button onclick={closeBatchModal}>close</button></form>
</dialog>


<dialog bind:this={dialogEl} class="modal" onclose={closeModal}>
  {#if modal}
    <div class="modal-box max-w-3xl w-full">
      <button class="btn btn-sm btn-circle btn-ghost absolute right-2 top-2" onclick={closeModal}>✕</button>

      <h3 class="font-bold text-base">
        {modal.ep.episodeTitle}
        <span class="font-mono text-sm opacity-50 ml-1">
          S{String(modal.ep.arcPart).padStart(2, "0")}E{String(modal.ep.episodeNum).padStart(2, "0")}
        </span>
      </h3>
      <p class="text-xs opacity-40 mb-4">
        {#if modal.ep.extended}<span class="mr-1">Extended cut ·</span>{/if}
        <span class="font-mono">{modal.ep.datasetCrc32}</span>
        <span class="mx-1">·</span>
        {modal.ep.arcTitle}
      </p>

      <!-- ── Compare view ── -->
      {#if modal.view === "compare"}
        {#if modal.infoLoading}
          <div class="flex justify-center py-10">
            <span class="loading loading-spinner loading-md"></span>
          </div>
        {:else}
          <div class="grid grid-cols-2 gap-3">
            <div class="rounded-lg border border-warning/40 bg-warning/5 p-3 flex flex-col gap-3">
              <div class="text-xs font-semibold text-warning uppercase tracking-wider">On Disk</div>
              {#if modal.ep.diskCrc32}
                {@render metaField("CRC32", modal.ep.diskCrc32, false, true)}
                {@render metaField("Resolution", parseResolution(modal.ep.diskFilename) ?? "unknown")}
                {@render metaField("Released", modal.old?.released ?? "unknown")}
                {@render metaField("Title", modal.old?.episodeTitle ?? "unknown", modal.old?.episodeTitle !== modal.curr?.episodeTitle)}
                {@render metaField("Chapters", modal.old?.chapters ?? "—")}
                {@render metaField("Original episodes", modal.old?.originalEpisodes ?? "—")}
                {#if modal.old?.episodeDescription}
                  {@render metaField("Description", modal.old.episodeDescription, modal.old.episodeDescription !== modal.curr?.episodeDescription)}
                {/if}
              {:else}
                <p class="text-sm opacity-40 italic">Not on disk</p>
              {/if}
            </div>
            <div class="rounded-lg border border-success/40 bg-success/5 p-3 flex flex-col gap-3">
              <div class="text-xs font-semibold text-success uppercase tracking-wider">Latest Release</div>
              {@render metaField("CRC32", modal.curr?.crc32 ?? modal.ep.datasetCrc32, false, true)}
              {@render metaField("Resolution", modal.curr?.resolution ?? "unknown")}
              {@render metaField("Released", modal.curr?.released ?? "unknown")}
              {@render metaField("Title", modal.curr?.episodeTitle ?? "unknown", modal.old?.episodeTitle !== modal.curr?.episodeTitle)}
              {@render metaField("Chapters", modal.curr?.chapters ?? "—")}
              {@render metaField("Original episodes", modal.curr?.originalEpisodes ?? "—")}
              {#if modal.curr?.episodeDescription}
                {@render metaField("Description", modal.curr.episodeDescription, modal.old?.episodeDescription !== modal.curr?.episodeDescription)}
              {/if}
            </div>
          </div>
        {/if}

        <div class="modal-action">
          {#if modal.upgrading}
            <button class="btn btn-sm btn-warning loading" disabled>Starting…</button>
          {:else if pipelineEp && ["pending", "downloading", "processing"].includes(pipelineEp.status)}
            <button class="btn btn-sm" disabled>
              {pipelineEp.status === "pending" ? "Queued" : pipelineEp.status === "downloading" ? "Downloading…" : "Processing…"}
            </button>
          {:else if modal.ep.hasMagnet}
            <button class="btn btn-sm btn-warning" disabled={modal.infoLoading} onclick={doUpgrade}>
              Update
            </button>
          {:else}
            <button class="btn btn-sm btn-primary" onclick={openSearch}>
              Search for torrent
            </button>
          {/if}
          <button class="btn btn-sm btn-ghost" onclick={closeModal}>Close</button>
        </div>
      {/if}

      <!-- ── Search view ── -->
      {#if modal.view === "search"}
        <div class="flex gap-2 mb-4">
          <input
            class="input input-sm input-bordered flex-1 font-mono"
            bind:value={modal.searchQuery}
            placeholder="Search query…"
            onkeydown={(e) => { if (e.key === "Enter") doSearch(); }}
          />
          <button class="btn btn-sm btn-primary gap-1" disabled={modal.searching} onclick={doSearch}>
            {#if modal.searching}<span class="loading loading-spinner loading-xs"></span>{/if}
            Search
          </button>
        </div>

        {#if modal.searching}
          <div class="flex justify-center py-10">
            <span class="loading loading-spinner loading-md"></span>
          </div>
        {:else if modal.searchError}
          <div class="alert alert-error text-sm py-2">{modal.searchError}</div>
        {:else if modal.searchResults !== null}
          {#if modal.searchResults.length === 0}
            <div class="text-center py-8 flex flex-col items-center gap-3">
              <p class="text-sm opacity-50">No results for <span class="font-mono">[{modal.ep.datasetCrc32}]</span></p>
              <p class="text-xs opacity-40 max-w-xs">
                This episode may only be available as part of a batch release.
              </p>
              <button
                class="btn btn-sm btn-outline"
                onclick={() => {
                  if (modal) {
                    modal = { ...modal, searchQuery: `One Pace ${modal.ep.arcTitle}` };
                    doSearch();
                  }
                }}
              >
                Search: "One Pace {modal.ep.arcTitle}"
              </button>
            </div>
          {:else}
            <div class="overflow-x-auto max-h-72 overflow-y-auto">
              <table class="table table-xs">
                <thead class="sticky top-0 bg-base-100">
                  <tr>
                    <th>Source</th>
                    <th>Title</th>
                    <th class="text-right">Size</th>
                    <th class="text-right" title="Seeders">↑</th>
                    <th class="text-right" title="Leechers">↓</th>
                    <th class="text-right">Age</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {#each modal.searchResults as result, i}
                    <tr class="hover">
                      <td>
                        <span class="badge badge-xs {result.source === 'animetosho' ? 'badge-info' : 'badge-success'} whitespace-nowrap">
                          {result.source === "animetosho" ? "AniTosho" : "Nyaa"}
                        </span>
                      </td>
                      <td class="max-w-[14rem]">
                        <div class="flex items-center gap-1 min-w-0">
                          {#if result.pageUrl}
                            <a href={result.pageUrl} target="_blank" rel="noopener noreferrer"
                              class="link link-hover font-mono text-xs truncate" title={result.title}
                            >{result.title}</a>
                          {:else}
                            <span class="font-mono text-xs truncate" title={result.title}>{result.title}</span>
                          {/if}
                          {#if result.isBatch}
                            <span class="badge badge-xs badge-warning shrink-0">batch</span>
                          {/if}
                        </div>
                      </td>
                      <td class="text-right tabular-nums text-xs whitespace-nowrap">
                        {result.size ? fmtBytes(result.size) : "—"}
                      </td>
                      <td class="text-right tabular-nums text-xs text-success">
                        {result.seeders !== null ? result.seeders : "?"}
                      </td>
                      <td class="text-right tabular-nums text-xs text-error/70">
                        {result.leechers !== null ? result.leechers : "?"}
                      </td>
                      <td class="text-right text-xs opacity-50 whitespace-nowrap">
                        {result.publishedAt ? fmtAge(result.publishedAt) : "—"}
                      </td>
                      <td>
                        <button
                          class="btn btn-xs btn-primary"
                          disabled={(!result.magnet && !result.torrentUrl) || modal.downloadingIdx !== null}
                          title={result.magnet ? "Download via magnet" : result.torrentUrl ? "Download via .torrent" : "No download source available"}
                          onclick={() => doDownloadSource(i)}
                        >
                          {#if modal.downloadingIdx === i}
                            <span class="loading loading-spinner loading-xs"></span>
                          {:else}
                            ↓
                          {/if}
                        </button>
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {/if}
        {:else}
          <p class="text-sm opacity-40 text-center py-8">Searching AniTosho and Nyaa…</p>
        {/if}

        <div class="modal-action">
          <button class="btn btn-sm btn-ghost" onclick={() => { if (modal) modal = { ...modal, view: "compare" }; }}>
            ← Back
          </button>
          <button class="btn btn-sm btn-ghost" onclick={closeModal}>Close</button>
        </div>
      {/if}
    </div>
    <form method="dialog" class="modal-backdrop"><button onclick={closeModal}>close</button></form>
  {/if}
</dialog>
