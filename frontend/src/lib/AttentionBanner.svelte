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
  const hasItems = $derived(failed > 0 || missing > 0 || upgradesReady > 0 || update !== null);

  // Dismissal sticks across reloads, but any change in the underlying
  // problems re-surfaces the banner.
  const DISMISS_KEY = "one-pace-banner-dismissed";
  const signature = $derived(`${failed}|${missing}|${upgradesReady}|${update ?? ""}`);
  let dismissedSig = $state<string | null>(
    typeof localStorage !== "undefined" ? localStorage.getItem(DISMISS_KEY) : null
  );
  const visible = $derived(hasItems && dismissedSig !== signature);

  function dismiss() {
    dismissedSig = signature;
    try {
      localStorage.setItem(DISMISS_KEY, signature);
    } catch {
      /* storage unavailable — session-only dismissal */
    }
  }
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
    <button
      class="btn btn-xs btn-ghost ml-auto"
      title="Dismiss until something changes"
      aria-label="Dismiss attention banner"
      onclick={dismiss}
    >
      ✕
    </button>
  </div>
{/if}
