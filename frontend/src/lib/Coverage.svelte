<script lang="ts">
  import { coverage, coverageLoading, runCoverageScan } from "./stores";
  import { fmtTime } from "./util";
  import { fetchEpisodeMetadata, type CoverageStatus, type CoverageEpisode, type EpisodeMetadata } from "./api";
  import { doEpisodeAction, status } from "./stores";

  // Which arcs are expanded (by arcPart).
  let open = $state<Record<number, boolean>>({});
  const toggle = (part: number) => (open[part] = !open[part]);

  const CHIP: Record<CoverageStatus, string> = {
    present: "bg-success/20 text-success border-success/30",
    present_unknown: "bg-base-content/10 text-base-content/60 border-base-content/20",
    upgradeable: "bg-warning/20 text-warning border-warning/40",
    missing: "bg-error/10 text-error/80 border-error/30 border-dashed",
  };

  const LABEL: Record<CoverageStatus, string> = {
    present: "present",
    present_unknown: "present (no CRC in name)",
    upgradeable: "re-release available",
    missing: "missing",
  };

  const pct = (n: number, d: number) => (d === 0 ? 0 : Math.round((n / d) * 100));

  interface ModalState {
    ep: CoverageEpisode;
    loading: boolean;
    old: EpisodeMetadata | null;
    curr: EpisodeMetadata | null;
  }

  let modal = $state<ModalState | null>(null);
  let dialogEl = $state<HTMLDialogElement | null>(null);

  $effect(() => {
    if (modal) dialogEl?.showModal();
    else dialogEl?.close();
  });

  async function openModal(ep: CoverageEpisode) {
    modal = { ep, loading: true, old: null, curr: null };
    const [oldMeta, currMeta] = await Promise.all([
      ep.diskCrc32 ? fetchEpisodeMetadata(ep.diskCrc32) : Promise.resolve(null),
      fetchEpisodeMetadata(ep.datasetCrc32),
    ]);
    if (modal) modal = { ...modal, loading: false, old: oldMeta, curr: currMeta };
  }

  function closeModal() {
    modal = null;
  }

  let upgrading = $state(false);

  const pipelineEp = $derived(
    modal
      ? ($status?.episodes ?? []).find(e => e.crc32.toUpperCase() === modal.ep.datasetCrc32.toUpperCase()) ?? null
      : null
  );

  async function doUpgrade() {
    if (!modal) return;
    upgrading = true;
    try {
      const r = await doEpisodeAction(modal.ep.datasetCrc32, "upgrade");
      if (r.ok) closeModal();
    } finally {
      upgrading = false;
    }
  }
</script>

<section class="deck-card card bg-base-100/60">
  <div class="card-body p-4 gap-4">
    <div class="flex items-center justify-between gap-3 flex-wrap">
      <div>
        <h2 class="eyebrow">Library Coverage</h2>
        <p class="text-xs opacity-60">
          Scans your media folder and diffs it against the One Pace catalog.
        </p>
      </div>
      <button
        class="btn btn-sm btn-primary"
        class:loading={$coverageLoading}
        disabled={$coverageLoading}
        onclick={runCoverageScan}
      >
        {$coverageLoading ? "Scanning…" : $coverage ? "Re-scan" : "Scan library"}
      </button>
    </div>

    {#if $coverage}
      {@const t = $coverage.totals}
      {#if !$coverage.mediaPathExists}
        <div class="alert alert-warning text-sm">
          Media path <code class="font-mono">{$coverage.mediaPath}</code> not found — nothing to scan.
        </div>
      {/if}

      <!-- Totals -->
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
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
          </div>
        </div>
        <div class="deck-card card bg-base-100/60">
          <div class="card-body p-3 gap-0.5">
            <span class="text-[0.65rem] uppercase tracking-wider opacity-60">Upgradeable</span>
            <span class="font-display text-2xl tabular-nums text-warning">{t.upgradeable}</span>
          </div>
        </div>
        <div class="deck-card card bg-base-100/60">
          <div class="card-body p-3 gap-0.5">
            <span class="text-[0.65rem] uppercase tracking-wider opacity-60">Extras</span>
            <span class="font-display text-2xl tabular-nums opacity-70">{$coverage.extras.length}</span>
            <span class="text-[0.65rem] opacity-50">unmatched files</span>
          </div>
        </div>
      </div>

      <!-- Per-arc -->
      <div class="flex flex-col gap-1.5">
        {#each $coverage.arcs as arc (arc.arcPart)}
          {@const complete = arc.missing === 0 && arc.upgradeable === 0}
          <div class="rounded-lg border border-base-content/10 bg-base-100/40 overflow-hidden">
            <button
              class="w-full flex items-center gap-3 px-3 py-2 hover:bg-base-content/5 text-left"
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
              {#if arc.missing > 0}
                <span class="badge badge-sm badge-error badge-outline">{arc.missing} missing</span>
              {/if}
              {#if complete}
                <span class="badge badge-sm badge-success badge-outline">complete</span>
              {/if}
              <span class="text-xs tabular-nums opacity-60 w-14 text-right">
                {arc.present}/{arc.total}
              </span>
              <div class="hidden sm:block w-24">
                <progress
                  class="progress progress-success h-1.5"
                  value={arc.present}
                  max={arc.total}
                ></progress>
              </div>
            </button>

            {#if open[arc.arcPart]}
              <div class="px-3 pb-3 pt-1 flex flex-wrap gap-1">
                {#each arc.episodes as ep (ep.datasetCrc32)}
                  {#if ep.status === "upgradeable"}
                    <button
                      class="badge badge-sm border font-mono tabular-nums cursor-pointer {CHIP[ep.status]}"
                      title={`E${ep.episodeNum} · ${ep.episodeTitle}\n${LABEL[ep.status]}${ep.diskFilename ? "\n" + ep.diskFilename : ""}\nClick to compare releases`}
                      onclick={() => openModal(ep)}
                    >
                      E{String(ep.episodeNum).padStart(2, "0")}
                    </button>
                  {:else}
                    <span
                      class="badge badge-sm border font-mono tabular-nums {CHIP[ep.status]}"
                      title={`E${ep.episodeNum} · ${ep.episodeTitle}\n${LABEL[ep.status]}${ep.diskFilename ? "\n" + ep.diskFilename : ""}`}
                    >
                      E{String(ep.episodeNum).padStart(2, "0")}
                    </span>
                  {/if}
                {/each}
              </div>
            {/if}
          </div>
        {/each}
      </div>

      <!-- Legend + extras -->
      <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-[0.65rem] opacity-60">
        <span class="inline-flex items-center gap-1"><span class="size-2 rounded-sm bg-success/40"></span> present</span>
        <span class="inline-flex items-center gap-1"><span class="size-2 rounded-sm bg-warning/50"></span> re-release available</span>
        <span class="inline-flex items-center gap-1"><span class="size-2 rounded-sm bg-error/40"></span> missing</span>
        <span class="inline-flex items-center gap-1"><span class="size-2 rounded-sm bg-base-content/20"></span> no CRC in name</span>
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

      <p class="text-[0.65rem] opacity-40">Scanned {fmtTime($coverage.scannedAt)}</p>
    {:else if !$coverageLoading}
      <p class="text-sm opacity-50">Run a scan to see which episodes you have, are missing, or can upgrade.</p>
    {/if}
  </div>
</section>

{#snippet metaField(label: string, value: string, highlight: boolean = false, mono: boolean = false)}
  <div class="flex flex-col gap-0.5">
    <span class="text-[0.6rem] uppercase tracking-wider opacity-50">{label}</span>
    <span class="text-sm break-words {mono ? 'font-mono text-xs' : ''} {highlight ? 'text-warning font-medium' : ''}">{value || "—"}</span>
  </div>
{/snippet}

<!-- Re-release comparison modal -->
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
      <p class="text-xs opacity-50 mb-4">Re-release comparison</p>

      {#if modal.loading}
        <div class="flex justify-center py-10">
          <span class="loading loading-spinner loading-md"></span>
        </div>
      {:else}
        <div class="grid grid-cols-2 gap-3">
          <!-- On disk (old) -->
          <div class="rounded-lg border border-warning/40 bg-warning/5 p-3 flex flex-col gap-3">
            <div class="text-xs font-semibold text-warning uppercase tracking-wider">On Disk</div>
            {@render metaField("CRC32", modal.ep.diskCrc32 ?? "unknown", false, true)}
            {@render metaField("Released", modal.old?.released ?? "unknown")}
            {@render metaField("Title", modal.old?.episodeTitle ?? "unknown", modal.old?.episodeTitle !== modal.curr?.episodeTitle)}
            {@render metaField("Chapters", modal.old?.chapters ?? "—")}
            {@render metaField("Original episodes", modal.old?.originalEpisodes ?? "—")}
            {#if modal.old?.episodeDescription}
              {@render metaField("Description", modal.old.episodeDescription, modal.old.episodeDescription !== modal.curr?.episodeDescription)}
            {/if}
          </div>

          <!-- Latest (new) -->
          <div class="rounded-lg border border-success/40 bg-success/5 p-3 flex flex-col gap-3">
            <div class="text-xs font-semibold text-success uppercase tracking-wider">Latest Release</div>
            {@render metaField("CRC32", modal.curr?.crc32 ?? modal.ep.datasetCrc32, false, true)}
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
        {#if upgrading}
          <button class="btn btn-sm btn-warning loading" disabled>Starting…</button>
        {:else if pipelineEp && ["pending", "downloading", "processing"].includes(pipelineEp.status)}
          <button class="btn btn-sm" disabled title="Already in pipeline">
            {pipelineEp.status === "pending" ? "Queued" : pipelineEp.status === "downloading" ? "Downloading…" : "Processing…"}
          </button>
        {:else}
          <button
            class="btn btn-sm btn-warning"
            disabled={modal.loading}
            onclick={doUpgrade}
          >
            Update
          </button>
        {/if}
        <button class="btn btn-sm btn-ghost" onclick={closeModal}>Close</button>
      </div>
    </div>
    <form method="dialog" class="modal-backdrop"><button onclick={closeModal}>close</button></form>
  {/if}
</dialog>
