<script lang="ts">
  import { status, coverage, changelogOpen } from "./stores";

  const failed = $derived(($status?.episodes ?? []).filter((e) => e.status === "failed").length);
  const missing = $derived($coverage?.totals.missing ?? 0);
  const upgradesReady = $derived(
    ($coverage?.arcs ?? []).reduce(
      (n, a) => n + a.episodes.filter((e) => e.status === "upgradeable" && e.hasMagnet).length,
      0
    )
  );
  const update = $derived($status?.updateAvailable ?? null);
  const visible = $derived(failed > 0 || missing > 0 || upgradesReady > 0 || update !== null);
</script>

{#if visible}
  <div role="alert" class="alert alert-warning gap-x-5 gap-y-1 py-2.5 flex-wrap text-sm">
    <span class="font-display uppercase tracking-widest text-xs opacity-70">Needs attention</span>
    {#if failed > 0}
      <a href="#pipeline" class="link font-medium whitespace-nowrap">
        {failed} failed download{failed === 1 ? "" : "s"}
      </a>
    {/if}
    {#if missing > 0}
      <a href="#library" class="link font-medium whitespace-nowrap">
        {missing} episode{missing === 1 ? "" : "s"} missing
      </a>
    {/if}
    {#if upgradesReady > 0}
      <a href="#library" class="link font-medium whitespace-nowrap">
        {upgradesReady} upgrade{upgradesReady === 1 ? "" : "s"} ready
      </a>
    {/if}
    {#if update}
      <button class="link font-medium whitespace-nowrap" onclick={() => ($changelogOpen = true)}>
        v{update} available
      </button>
    {/if}
  </div>
{/if}
