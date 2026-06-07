<script lang="ts">
  import { status } from "./stores";
  import { STATUS_ORDER } from "./util";

  const dotColor: Record<string, string> = {
    available: "bg-accent",
    pending: "bg-neutral-content/40",
    downloading: "bg-info",
    processing: "bg-warning",
    done: "bg-success",
    failed: "bg-error",
  };
</script>

{#if $status}
  <div class="grid grid-cols-3 sm:grid-cols-6 gap-2">
    {#each STATUS_ORDER as k}
      <div class="deck-card card bg-base-100/60">
        <div class="card-body p-3 gap-1">
          <div class="flex items-center gap-1.5">
            <span class="inline-block size-2 rounded-full {dotColor[k] ?? 'bg-base-content/30'}"></span>
            <span class="text-[0.65rem] uppercase tracking-wider opacity-60">{k}</span>
          </div>
          <span class="font-display text-2xl tabular-nums">{$status.counts[k] ?? 0}</span>
        </div>
      </div>
    {/each}
  </div>
{/if}
