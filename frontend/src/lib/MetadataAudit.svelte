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

  const flaggedCount = $derived($metadataAudit ? $metadataAudit.totals.flagged + $metadataAudit.seasonsFlagged : 0);

  // Sync only the flagged episodes/seasons. The server re-audits afterward and
  // the status poll pulls the fresh report, so the card updates on its own.
  async function syncFlagged() {
    syncing = true;
    try {
      const res = await postAction("metadata-sync");
      toast(res.message, res.ok);
    } catch {
      toast("Metadata sync failed", false);
    } finally {
      syncing = false;
      refreshStatus();
    }
  }

  function epTitle(state: MetadataState, expectedTitle: string, plexTitle: string | null): string {
    const lines = [`${expectedTitle || "(no dataset title)"}`, LABEL[state]];
    if (state === "drifted" && plexTitle) lines.push(`Plex: ${plexTitle}`);
    return lines.join("\n");
  }
</script>

<section class="deck-card card bg-base-100/60">
  <div class="card-body p-4 gap-4">
    <div class="flex items-center justify-between gap-3 flex-wrap">
      <div>
        <h2 class="eyebrow">Metadata Audit</h2>
        <p class="text-xs opacity-60">
          Diffs Plex's episode &amp; season titles/summaries against the One Pace dataset.
        </p>
      </div>
      <div class="flex gap-2">
        {#if $metadataAudit && flaggedCount > 0}
          <button
            class="btn btn-sm btn-warning"
            class:loading={syncing}
            disabled={syncing || $metadataAuditLoading}
            onclick={syncFlagged}
          >
            {syncing ? "Syncing…" : `Sync flagged (${flaggedCount})`}
          </button>
        {/if}
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
            <span class="text-[0.65rem] uppercase tracking-wider opacity-60">Seasons flagged</span>
            <span class="font-display text-2xl tabular-nums text-warning/90">{$metadataAudit.seasonsFlagged}</span>
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

      {#if flaggedCount === 0}
        <div class="alert alert-success text-sm py-2">
          All Plex metadata matches the dataset. Nothing to sync.
        </div>
      {/if}

      <!-- Per-arc foldout: only arcs with something flagged are expandable-worthy,
           but show all so completeness is visible. -->
      <div class="flex flex-col gap-1.5">
        {#each $metadataAudit.arcs as arc (arc.arcPart)}
          {@const flagged = arc.missing + arc.drifted}
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
              {#if flagged === 0 && !seasonFlagged}
                <span class="badge badge-sm badge-success badge-outline">ok</span>
              {/if}
              <span class="text-xs tabular-nums opacity-60 w-14 text-right">{arc.ok}/{arc.total}</span>
            </button>

            {#if open[arc.arcPart]}
              <div class="px-3 pb-3 pt-1 flex flex-wrap gap-1">
                {#each arc.episodes as ep (ep.seasonEpisodeId)}
                  <span
                    class="badge badge-sm border font-mono tabular-nums {CHIP[ep.state]}"
                    title={epTitle(ep.state, ep.expectedTitle, ep.plexTitle)}
                  >
                    E{String(ep.episodeNum).padStart(2, "0")}
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
      </div>

      <p class="text-[0.65rem] opacity-40">Audited {fmtTime($metadataAudit.scannedAt)}</p>
    {:else if !$metadataAuditLoading}
      <p class="text-sm opacity-50">
        Run an audit to see which episodes are missing metadata or have drifted from the dataset — then sync just those instead of the whole library.
      </p>
    {/if}
  </div>
</section>
