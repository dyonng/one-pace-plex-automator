<script lang="ts">
  import { status } from "./stores";
  const order = ["pending", "downloading", "processing", "done", "failed"];
</script>

{#if $status}
  <div class="stats stats-vertical sm:stats-horizontal shadow bg-base-100 w-full">
    {#each order as k}
      <div class="stat py-2">
        <div class="stat-title capitalize">{k}</div>
        <div class="stat-value text-2xl">{$status.counts[k] ?? 0}</div>
      </div>
    {/each}
  </div>
{/if}
