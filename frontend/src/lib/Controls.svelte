<script lang="ts">
  import { status, toast, refreshStatus } from "./stores";
  import { postAction, fetchNamingCandidates, normalizeNaming, type NamingCandidate } from "./api";

  const buttons = [
    {
      id: "refresh-sources",
      label: "Refresh Sources",
      cls: "btn-primary",
      tip: "Clears caches and re-fetches the metadata dataset, episode-guide sheets, and RSS feed to pick up new or updated releases — the same cycle the scheduler runs. With auto-reconcile on, it also pushes any changed Plex metadata and generates missing thumbnails.",
    },
    {
      id: "retry-failed",
      label: "Retry failed",
      cls: "btn-outline btn-warning",
      tip: "Re-queues every episode whose download or processing previously failed, sending them back through the pipeline.",
    },
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

  // ── Full Plex sync confirmation ──────────────────────────────────────────────
  let syncDialogEl = $state<HTMLDialogElement | null>(null);
  let syncOpen = $state(false);

  $effect(() => {
    if (syncOpen) syncDialogEl?.showModal();
    else syncDialogEl?.close();
  });

  function openSyncModal() { syncOpen = true; }
  function closeSyncModal() { syncOpen = false; }

  async function confirmSync() {
    closeSyncModal();
    await run("sync");
  }

  // ── Normalize file naming ────────────────────────────────────────────────────
  let nameOpen = $state(false);
  let nameDialogEl = $state<HTMLDialogElement | null>(null);
  let nameLoading = $state(false);
  let nameRenaming = $state(false);
  let candidates = $state<NamingCandidate[]>([]);
  let nameSelected = $state(new Set<string>());

  $effect(() => {
    if (nameOpen) nameDialogEl?.showModal();
    else nameDialogEl?.close();
  });

  const allNameSelected = $derived(
    candidates.length > 0 && candidates.every((c) => nameSelected.has(c.crc32))
  );
  const someNameSelected = $derived(candidates.some((c) => nameSelected.has(c.crc32)));

  function toggleAllNames() {
    nameSelected = allNameSelected ? new Set() : new Set(candidates.map((c) => c.crc32));
  }
  function toggleName(crc32: string) {
    const s = new Set(nameSelected);
    if (s.has(crc32)) s.delete(crc32); else s.add(crc32);
    nameSelected = s;
  }

  async function openNameModal() {
    nameOpen = true;
    nameLoading = true;
    candidates = [];
    nameSelected = new Set();
    try {
      candidates = await fetchNamingCandidates();
      nameSelected = new Set(candidates.map((c) => c.crc32));
    } catch {
      toast("Failed to scan file names", false);
    } finally {
      nameLoading = false;
    }
  }

  function closeNameModal() {
    nameOpen = false;
  }

  async function doNormalize() {
    if (nameSelected.size === 0) return;
    nameRenaming = true;
    try {
      const res = await normalizeNaming([...nameSelected]);
      toast(res.message, res.ok);
      if (res.ok) closeNameModal();
      else candidates = await fetchNamingCandidates(); // refresh remaining
    } catch {
      toast("Rename failed", false);
    } finally {
      nameRenaming = false;
      refreshStatus();
    }
  }
</script>

<section class="deck-card card bg-base-100/70">
  <div class="card-body py-4 gap-3">
    <div class="eyebrow">Operations</div>
    <div class="flex flex-wrap gap-2">
      {#each buttons as b}
        <div class="tooltip tooltip-top before:max-w-xs before:whitespace-normal" data-tip={b.tip}>
          <button
            class="btn btn-sm {b.cls} gap-1.5"
            disabled={$status?.busy || pending !== null}
            onclick={() => run(b.id)}
          >
            {#if pending === b.id}<span class="loading loading-spinner loading-xs"></span>{/if}
            {b.label}
          </button>
        </div>
      {/each}
      <div
        class="tooltip tooltip-top before:max-w-xs before:whitespace-normal"
        data-tip="Re-pushes titles and descriptions for every season and episode to Plex, then re-checks all season posters. The force-everything fallback — day-to-day syncing happens automatically, so this is rarely needed."
      >
        <button
          class="btn btn-sm btn-secondary gap-1.5"
          disabled={$status?.busy || pending !== null}
          onclick={openSyncModal}
        >
          {#if pending === "sync"}<span class="loading loading-spinner loading-xs"></span>{/if}
          Full Plex sync
        </button>
      </div>
      <div
        class="tooltip tooltip-top before:max-w-xs before:whitespace-normal"
        data-tip="Finds library files whose names don't match the canonical One Pace scheme, previews each old → new rename, and applies the ones you select."
      >
        <button
          class="btn btn-sm btn-outline gap-1.5"
          disabled={$status?.busy || pending !== null}
          onclick={openNameModal}
        >
          Normalize File Naming
        </button>
      </div>
      <div
        class="tooltip tooltip-top before:max-w-xs before:whitespace-normal"
        data-tip="Removes the cast added to the One Pace show and refreshes the original series to rebuild its cast — use if a cast sync left blank/broken actors."
      >
        <button
          class="btn btn-sm btn-ghost gap-1.5"
          disabled={$status?.busy || pending !== null}
          onclick={() => run("reset-cast")}
        >
          {#if pending === "reset-cast"}<span class="loading loading-spinner loading-xs"></span>{/if}
          Reset cast
        </button>
      </div>
    </div>
  </div>
</section>

<!-- Full Plex sync confirmation -->
<dialog bind:this={syncDialogEl} class="modal" onclose={closeSyncModal}>
  <div class="modal-box deck-card">
    <h3 class="font-bold text-base">Full Plex sync?</h3>
    <p class="text-sm opacity-70 mt-1 mb-3">
      This updates metadata for every season and episode in Plex, then checks all arc posters for changes.
      It makes a large number of requests to Plex and may take a while.
    </p>
    <div class="modal-action">
      <button class="btn btn-sm btn-ghost" onclick={closeSyncModal}>Cancel</button>
      <button class="btn btn-sm btn-secondary" onclick={confirmSync}>Sync</button>
    </div>
  </div>
  <form method="dialog" class="modal-backdrop"><button onclick={closeSyncModal}>close</button></form>
</dialog>

<!-- Normalize file naming modal -->
<dialog bind:this={nameDialogEl} class="modal" onclose={closeNameModal}>
  <div class="modal-box max-w-5xl w-full">
    <button class="btn btn-sm btn-circle btn-ghost absolute right-2 top-2" onclick={closeNameModal}>✕</button>
    <h3 class="font-bold text-base">Normalize File Naming</h3>
    <p class="text-xs opacity-50 mb-4">
      Files whose names don't match the canonical scheme. The new name is derived from each file's CRC32.
    </p>

    {#if nameLoading}
      <div class="flex justify-center py-10"><span class="loading loading-spinner loading-md"></span></div>
    {:else if candidates.length === 0}
      <div class="py-8 text-center text-sm opacity-60">Everything already follows the naming scheme. 🎉</div>
    {:else}
      <div class="overflow-x-auto max-h-[60vh] rounded-box border border-base-content/10">
        <table class="table table-sm table-pin-rows">
          <thead>
            <tr class="text-xs uppercase tracking-wider">
              <th class="w-8">
                <input
                  type="checkbox"
                  class="checkbox checkbox-xs"
                  checked={allNameSelected}
                  indeterminate={someNameSelected && !allNameSelected}
                  onchange={toggleAllNames}
                />
              </th>
              <th>S/E</th>
              <th>Old name</th>
              <th>New name</th>
            </tr>
          </thead>
          <tbody>
            {#each candidates as c (c.crc32)}
              <tr class="hover:bg-base-200/40 align-top">
                <td>
                  <input
                    type="checkbox"
                    class="checkbox checkbox-xs"
                    checked={nameSelected.has(c.crc32)}
                    onchange={() => toggleName(c.crc32)}
                  />
                </td>
                <td class="font-mono text-xs text-primary whitespace-nowrap">
                  S{String(c.arcPart).padStart(2, "0")}E{String(c.episodeNum).padStart(2, "0")}
                  {#if c.extended}<span class="badge badge-xs badge-info badge-outline ml-1">EXT</span>{/if}
                </td>
                <td class="font-mono text-xs opacity-60 break-all max-w-[20rem]">{c.oldName}</td>
                <td class="font-mono text-xs text-success break-all max-w-[20rem]">{c.newName}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}

    <div class="modal-action">
      {#if nameRenaming}
        <button class="btn btn-sm btn-primary loading" disabled>Renaming…</button>
      {:else}
        <button
          class="btn btn-sm btn-primary"
          disabled={nameSelected.size === 0}
          onclick={doNormalize}
        >
          Rename Selected ({nameSelected.size})
        </button>
      {/if}
      <button class="btn btn-sm btn-ghost" onclick={closeNameModal}>Close</button>
    </div>
  </div>
  <form method="dialog" class="modal-backdrop"><button onclick={closeNameModal}>close</button></form>
</dialog>
