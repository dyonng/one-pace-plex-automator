<script lang="ts">
  import { status, toast, refreshStatus } from "./stores";
  import { postAction } from "./api";

  const buttons = [
    { id: "poll", label: "Poll RSS now", cls: "btn-primary" },
    { id: "sync", label: "Full Plex sync", cls: "btn-secondary" },
    { id: "refresh-metadata", label: "Refresh metadata", cls: "btn-accent" },
    { id: "retry-failed", label: "Retry failed", cls: "btn-warning" },
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

<div class="card bg-base-100 shadow">
  <div class="card-body py-4">
    <h2 class="card-title text-base">Controls</h2>
    <div class="flex flex-wrap gap-2">
      {#each buttons as b}
        <button
          class="btn btn-sm {b.cls}"
          disabled={$status?.busy || pending !== null}
          onclick={() => run(b.id)}
        >
          {#if pending === b.id}<span class="loading loading-spinner loading-xs"></span>{/if}
          {b.label}
        </button>
      {/each}
    </div>
  </div>
</div>
