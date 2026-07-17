<script lang="ts">
  import {
    metadataAudit,
    metadataAuditLoading,
    runMetadataAuditScan,
    toast,
    refreshStatus,
  } from "./stores";
  import { postAction, type MetadataState } from "./api";
  import { fmtTime } from "./util";

  let open = $state<Record<number, boolean>>({});
  const toggle = (part: number) => (open[part] = !open[part]);

  let syncing = $state(false);

  const CHIP: Record<MetadataState, string> = {
    ok: "bg-success/20 text-success border-success/30",
    missing: "bg-error/10 text-error/80 border-error/30 border-dashed",
    drifted: "bg-warning/20 text-warning border-warning/40",
    not_in_plex: "bg-base-content/10 text-base-content/50 border-base-content/20",
  };

  const LABEL: Record<MetadataState, string> = {
    ok: "up to date",
    missing: "missing metadata",
    drifted: "drifted from dataset",
    not_in_plex: "not in Plex",
  };

  const flaggedCount = $derived(
    $metadataAudit
      ? $metadataAudit.totals.flagged + $metadataAudit.seasonsFlagged + $metadataAudit.totals.needsThumb
      : 0
  );

  // Reconcile: push flagged metadata + trigger thumbnail generation. The server
  // re-audits afterward and the status poll pulls the fresh report, so the card
  // updates on its own.
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

  function epTitle(ep: {
    state: MetadataState;
    expectedTitle: string;
    plexTitle: string | null;
    needsThumb: boolean;
    thumbUnavailable: boolean;
  }): string {
    const lines = [`${ep.expectedTitle || "(no dataset title)"}`, LABEL[ep.state]];
    if (ep.state === "drifted" && ep.plexTitle) lines.push(`Plex: ${ep.plexTitle}`);
    if (ep.needsThumb) lines.push("• no thumbnail (will generate)");
    if (ep.thumbUnavailable) lines.push("• no thumbnail (generation gave up)");
    return lines.join("\n");
  }
</script>

<section class="deck-card card bg-base-100/60">
  <div class="card-body p-4 gap-4">
    <div class="flex items-center justify-between gap-3 flex-wrap">
      <div>
        <h2 class="eyebrow">Metadata &amp; Thumbnails</h2>
        <p class="text-xs opacity-60">
          Diffs Plex against the One Pace dataset, then fills missing/drifted metadata and generates missing thumbnails.
        </p>
      </div>
      <div class="flex gap-2">
        {#if $metadataAudit}
          <div
            class="tooltip tooltip-top before:max-w-xs before:whitespace-normal"
            data-tip="Pushes the flagged missing/drifted metadata to Plex and triggers thumbnail generation for episodes missing one. Only touches what's flagged, not the whole library."
          >
            <button
              class="btn btn-sm {flaggedCount > 0 ? 'btn-warning' : 'btn-outline'}"
              class:loading={syncing}
              disabled={syncing || $metadataAuditLoading}
              onclick={syncFlagged}
            >
              {syncing ? "Reconciling…" : flaggedCount > 0 ? `Reconcile (${flaggedCount})` : "Reconcile"}
            </button>
          </div>
        {/if}
        <div
          class="tooltip tooltip-top before:max-w-xs before:whitespace-normal"
          data-tip="Checks Plex against the One Pace dataset and flags episodes with missing or drifted metadata, or no thumbnail. Read-only — makes no changes to Plex."
        >
          <button
            class="btn btn-sm btn-primary"
            class:loading={$metadataAuditLoading}
            disabled={$metadataAuditLoading || syncing}
            onclick={runMetadataAuditScan}
          >
            {$metadataAuditLoading ? "Scanning…" : $metadataAudit ? "Re-scan" : "Scan metadata"}
          </button>
        </div>
      </div>
    </div>

    {#if $metadataAudit}
      {@const t = $metadataAudit.totals}
      <!-- Totals -->
      <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
        <div class="deck-card card bg-base-100/60">
          <div class="card-body p-3 gap-0.5">
            <span class="text-[0.65rem] uppercase tracking-wider opacity-60">Up to date</span>
            <span class="font-display text-2xl tabular-nums text-success">{t.ok}</span>
            <span class="text-[0.65rem] opacity-50">of {t.episodes} episodes</span>
          </div>
        </div>
        <div class="deck-card card bg-base-100/60">
          <div class="card-body p-3 gap-0.5">
            <span class="text-[0.65rem] uppercase tracking-wider opacity-60">Missing</span>
            <span class="font-display text-2xl tabular-nums text-error/80">{t.missing}</span>
            <span class="text-[0.65rem] opacity-50">never synced</span>
          </div>
        </div>
        <div class="deck-card card bg-base-100/60">
          <div class="card-body p-3 gap-0.5">
            <span class="text-[0.65rem] uppercase tracking-wider opacity-60">Drifted</span>
            <span class="font-display text-2xl tabular-nums text-warning">{t.drifted}</span>
            <span class="text-[0.65rem] opacity-50">differs from dataset</span>
          </div>
        </div>
        <div class="deck-card card bg-base-100/60">
          <div class="card-body p-3 gap-0.5">
            <span class="text-[0.65rem] uppercase tracking-wider opacity-60">Missing thumbnails</span>
            <span class="font-display text-2xl tabular-nums text-info">{t.needsThumb}</span>
            {#if t.thumbUnavailable > 0}
              <span class="text-[0.65rem] opacity-50">{t.thumbUnavailable} unavailable</span>
            {/if}
          </div>
        </div>
        <div class="deck-card card bg-base-100/60">
          <div class="card-body p-3 gap-0.5">
            <span class="text-[0.65rem] uppercase tracking-wider opacity-60">Not in Plex</span>
            <span class="font-display text-2xl tabular-nums opacity-70">{t.notInPlex}</span>
            <span class="text-[0.65rem] opacity-50">not downloaded</span>
          </div>
        </div>
      </div>
      <p class="text-[0.6rem] opacity-40 -mt-2">
        Seasons flagged: {$metadataAudit.seasonsFlagged}
      </p>

      {#if flaggedCount === 0}
        <div class="alert alert-success text-sm py-2">
          Plex metadata matches the dataset and every episode has a thumbnail. Nothing to do.
        </div>
      {/if}

      <!-- Per-arc foldout: only arcs with something flagged are expandable-worthy,
           but show all so completeness is visible. -->
      <div class="flex flex-col gap-1.5">
        {#each $metadataAudit.arcs as arc (arc.arcPart)}
          {@const flagged = arc.missing + arc.drifted + arc.needsThumb}
          {@const seasonFlagged = arc.seasonState === "missing" || arc.seasonState === "drifted"}
          <div class="rounded-lg border border-base-content/10 bg-base-100/40 overflow-hidden">
            <button
              class="w-full flex items-center gap-3 px-3 py-2 hover:bg-base-content/5 text-left"
              onclick={() => toggle(arc.arcPart)}
            >
              <span class="opacity-40 text-xs w-3">{open[arc.arcPart] ? "▾" : "▸"}</span>
              <span class="font-mono text-xs opacity-50 tabular-nums">S{String(arc.arcPart).padStart(2, "0")}</span>
              <span class="flex-1 truncate text-sm">{arc.arcTitle}</span>
              {#if seasonFlagged}
                <span class="badge badge-sm badge-warning badge-outline" title="Season title/summary {LABEL[arc.seasonState]}">season</span>
              {/if}
              {#if arc.missing > 0}
                <span class="badge badge-sm badge-error badge-outline">{arc.missing} missing</span>
              {/if}
              {#if arc.drifted > 0}
                <span class="badge badge-sm badge-warning">{arc.drifted} drifted</span>
              {/if}
              {#if arc.needsThumb > 0}
                <span class="badge badge-sm badge-info badge-outline">{arc.needsThumb} thumb</span>
              {/if}
              {#if flagged === 0 && !seasonFlagged}
                <span class="badge badge-sm badge-success badge-outline">ok</span>
              {/if}
              <span class="text-xs tabular-nums opacity-60 w-14 text-right">{arc.ok}/{arc.total}</span>
            </button>

            {#if open[arc.arcPart]}
              <div class="px-3 pb-3 pt-1 flex flex-wrap gap-1">
                {#each arc.episodes as ep (ep.seasonEpisodeId)}
                  <span
                    class="relative badge badge-sm border font-mono tabular-nums {CHIP[ep.state]}"
                    title={epTitle(ep)}
                  >
                    E{String(ep.episodeNum).padStart(2, "0")}
                    {#if ep.needsThumb}
                      <span class="absolute -top-1 -right-1 size-1.5 rounded-full bg-info" title="no thumbnail"></span>
                    {:else if ep.thumbUnavailable}
                      <span class="absolute -top-1 -right-1 size-1.5 rounded-full bg-base-content/40" title="thumbnail unavailable"></span>
                    {/if}
                  </span>
                {/each}
              </div>
            {/if}
          </div>
        {/each}
      </div>

      <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-[0.65rem] opacity-60">
        <span class="inline-flex items-center gap-1"><span class="size-2 rounded-sm bg-success/40"></span> up to date</span>
        <span class="inline-flex items-center gap-1"><span class="size-2 rounded-sm border border-dashed border-error/50"></span> missing</span>
        <span class="inline-flex items-center gap-1"><span class="size-2 rounded-sm bg-warning/50"></span> drifted</span>
        <span class="inline-flex items-center gap-1"><span class="size-2 rounded-sm bg-base-content/20"></span> not in Plex</span>
        <span class="inline-flex items-center gap-1"><span class="size-1.5 rounded-full bg-info"></span> no thumbnail</span>
      </div>

      <p class="text-[0.65rem] opacity-40">Audited {fmtTime($metadataAudit.scannedAt)}</p>
    {:else if !$metadataAuditLoading}
      <p class="text-sm opacity-50">
        Run an audit to see which episodes are missing metadata, have drifted from the dataset, or lack a thumbnail — then reconcile just those instead of syncing the whole library. This also runs automatically when sources change (toggle in Settings).
      </p>
    {/if}
  </div>
</section>
