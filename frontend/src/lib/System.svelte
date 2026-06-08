<script lang="ts">
  import { status, health, healthLoading, runHealthCheck } from "./stores";
  import { fmtTime, fmtBytes, fmtUptime, STATUS_ORDER } from "./util";
  import type { HealthStatus } from "./api";

  const DOT: Record<HealthStatus, string> = {
    ok: "bg-success",
    warn: "bg-warning",
    error: "bg-error",
  };
  const BAR: Record<HealthStatus, string> = {
    ok: "progress-success",
    warn: "progress-warning",
    error: "progress-error",
  };
  const OVERALL: Record<HealthStatus, string> = {
    ok: "badge-success",
    warn: "badge-warning",
    error: "badge-error",
  };
  const OVERALL_LABEL: Record<HealthStatus, string> = {
    ok: "All systems go",
    warn: "Needs attention",
    error: "Problem detected",
  };

  // Episode pipeline (formerly the Stats card).
  const pipeDot: Record<string, string> = {
    available: "bg-accent",
    pending: "bg-neutral-content/40",
    downloading: "bg-info",
    processing: "bg-warning",
    done: "bg-success",
    failed: "bg-error",
  };
</script>

<section class="deck-card card bg-base-100/60">
  <div class="card-body p-4 gap-4">
    <div class="flex items-center justify-between gap-3 flex-wrap">
      <div class="flex items-center gap-3">
        <h2 class="eyebrow">System</h2>
        {#if $health}
          <span class="badge badge-sm {OVERALL[$health.overall]}">{OVERALL_LABEL[$health.overall]}</span>
        {/if}
      </div>
      <button
        class="btn btn-sm btn-ghost"
        class:loading={$healthLoading}
        disabled={$healthLoading}
        onclick={runHealthCheck}
      >
        {$healthLoading ? "Checking…" : "Check now"}
      </button>
    </div>

    <!-- Services -->
    {#if $health}
      <div class="flex flex-col gap-2">
        <span class="text-[0.65rem] uppercase tracking-wider opacity-40">Services</span>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
          {#each $health.checks as c (c.name)}
            <div class="flex items-center gap-2 rounded-lg bg-base-100/40 px-3 py-2">
              <span class="inline-block size-2 rounded-full {DOT[c.status]}"></span>
              <span class="text-sm">{c.name}</span>
              <span class="flex-1 truncate text-xs opacity-50 text-right">{c.detail}</span>
              {#if c.latencyMs != null}
                <span class="text-[0.65rem] tabular-nums opacity-40 w-12 text-right">{c.latencyMs}ms</span>
              {/if}
            </div>
          {/each}
          {#each $health.disks as d (d.path)}
            <div class="rounded-lg bg-base-100/40 px-3 py-2 flex flex-col gap-1">
              <div class="flex items-center gap-2">
                <span class="inline-block size-2 rounded-full {DOT[d.status]}"></span>
                <span class="text-sm">{d.name}</span>
                <span class="flex-1 text-xs opacity-50 text-right tabular-nums">
                  {#if d.totalBytes > 0}
                    {fmtBytes(d.freeBytes)} free of {fmtBytes(d.totalBytes)}
                  {:else}
                    unavailable
                  {/if}
                </span>
              </div>
              {#if d.totalBytes > 0}
                <progress class="progress {BAR[d.status]} h-1.5" value={100 - d.freePct} max="100"></progress>
              {/if}
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <!-- Pipeline -->
    {#if $status}
      <div class="flex flex-col gap-2">
        <span class="text-[0.65rem] uppercase tracking-wider opacity-40">Pipeline</span>
        <div class="grid grid-cols-3 sm:grid-cols-6 gap-2">
          {#each STATUS_ORDER as k}
            <div class="rounded-lg bg-base-100/40 px-3 py-2 flex flex-col gap-1">
              <div class="flex items-center gap-1.5">
                <span class="inline-block size-2 rounded-full {pipeDot[k] ?? 'bg-base-content/30'}"></span>
                <span class="text-[0.65rem] uppercase tracking-wider opacity-60">{k}</span>
              </div>
              <span class="font-display text-2xl tabular-nums">{$status.counts[k] ?? 0}</span>
            </div>
          {/each}
        </div>
      </div>
    {/if}

    {#if $health}
      <div class="flex flex-wrap gap-x-4 gap-y-1 text-[0.65rem] opacity-50">
        <span>
          Last poll:
          {#if $health.lastPollAgoSec != null}
            {fmtUptime($health.lastPollAgoSec)} ago
          {:else}
            never
          {/if}
        </span>
        <span>Health checked {fmtTime($health.checkedAt)}</span>
      </div>
    {/if}
  </div>
</section>
