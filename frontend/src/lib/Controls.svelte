<script lang="ts">
  import { status, toast, refreshStatus } from "./stores";
  import { postAction } from "./api";

  const buttons = [
    { id: "poll", label: "Poll RSS", cls: "btn-primary" },
    { id: "sync", label: "Full Plex sync", cls: "btn-secondary" },
    { id: "refresh-metadata", label: "Refresh metadata", cls: "btn-outline" },
    { id: "retry-failed", label: "Retry failed", cls: "btn-outline btn-warning" },
  ];

  let pending = $state<string | null>(null);

  async function run(id: string) {
    pending = id;
    try {
      const res = await postAction(id);
      toast(res.message, res.ok);
    } catch {
      toast("Request failed", false);
    } finally {
      pending = null;
      refreshStatus();
    }
  }
</script>

<section class="deck-card card bg-base-100/70">
  <div class="card-body py-4 gap-3">
    <div class="eyebrow">Operations</div>
    <div class="flex flex-wrap gap-2">
      {#each buttons as b}
        <button
          class="btn btn-sm {b.cls} gap-1.5"
          disabled={$status?.busy || pending !== null}
          onclick={() => run(b.id)}
        >
          {#if pending === b.id}<span class="loading loading-spinner loading-xs"></span>{/if}
          {b.label}
        </button>
      {/each}
    </div>
  </div>
</section>
