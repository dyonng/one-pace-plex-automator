<script lang="ts">
  import { coverage, coverageLoading, runCoverageScan } from "./stores";
  import { fmtTime } from "./util";
  import type { CoverageStatus } from "./api";

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
                {#each arc.episodes as ep (ep.episodeNum)}
                  <span
                    class="badge badge-sm border font-mono tabular-nums {CHIP[ep.status]}"
                    title={`E${ep.episodeNum} · ${ep.episodeTitle}\n${LABEL[ep.status]}${ep.diskFilename ? "\n" + ep.diskFilename : ""}`}
                  >
                    E{String(ep.episodeNum).padStart(2, "0")}
                  </span>
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
