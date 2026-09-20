<script lang="ts">
  import { status, doEpisodeAction, doBulkEpisodeAction, downloadProgress, toast, refreshStatus } from "./stores";
  import { fmtTime, fmtSpeed, fmtEta, fmtBytes, STATUS_BADGE } from "./util";
  import { postAction, type Episode } from "./api";
  import { sortEpisodes, toggleSort, DEFAULT_SORT, type SortKey, type SortState } from "./sort";
  import { needsTypeConfirm, typeConfirmOk, CONFIRM_WORD } from "./confirm";

  let busy = $state<string | null>(null);
  let removeTarget = $state<Episode | null>(null);
  let removeFile = $state(false);
  let clearing = $state(false);

  let sort = $state<SortState>(DEFAULT_SORT);
  let selected = $state(new Set<string>());
  // Row index the last plain/shift click landed on, for range selection.
  let anchor = $state<number | null>(null);
  let bulkBusy = $state(false);
  let bulkRemoveOpen = $state(false);
  let bulkDeleteFile = $state(false);
  // Deleting files across a large selection is the one action with no undo, and a
  // select-all plus one click is enough to do it. Require the word to be typed
  // once the selection is big enough that the blast radius stops being obvious.
  let bulkConfirmText = $state("");
  const typeConfirmRequired = $derived(needsTypeConfirm(bulkDeleteFile, selectedEpisodes.length));
  const typeConfirmPassed = $derived(typeConfirmOk(bulkConfirmText));

  const episodes = $derived(sortEpisodes($status?.episodes ?? [], sort));
  const doneCount = $derived(($status?.episodes ?? []).filter((e) => e.status === "done").length);

  // Intersected with the live rows: a refresh can drop an episode that was
  // selected a moment ago, and acting on a vanished CRC32 would just error.
  const selectedEpisodes = $derived(episodes.filter((e) => selected.has(e.crc32)));
  // Retry restarts a download, so it covers the two states that expose a
  // start-download action. Rows already moving (or done) are left alone.
  const retryable = $derived(
    selectedEpisodes.filter((e) => e.status === "failed" || e.status === "available")
  );
  const allSelected = $derived(episodes.length > 0 && episodes.every((e) => selected.has(e.crc32)));

  function toggleAll() {
    selected = allSelected ? new Set() : new Set(episodes.map((e) => e.crc32));
    anchor = null;
  }

  function selectRow(e: Episode, index: number, shiftKey: boolean) {
    const next = new Set(selected);
    if (shiftKey && anchor !== null) {
      const [lo, hi] = anchor < index ? [anchor, index] : [index, anchor];
      for (let i = lo; i <= hi; i++) next.add(episodes[i].crc32);
    } else {
      if (next.has(e.crc32)) next.delete(e.crc32);
      else next.add(e.crc32);
      anchor = index;
    }
    selected = next;
  }

  async function act(e: Episode, action: "download" | "retry" | "resync") {
    busy = e.crc32;
    try {
      await doEpisodeAction(e.crc32, action);
    } finally {
      busy = null;
    }
  }

  async function clearDone() {
    clearing = true;
    try {
      const res = await postAction("clear-done");
      toast(res.message, res.ok);
    } catch {
      toast("Request failed", false);
    } finally {
      clearing = false;
      refreshStatus();
    }
  }

  function askRemove(e: Episode) {
    removeTarget = e;
    removeFile = false;
  }

  async function confirmRemove() {
    if (!removeTarget) return;
    const e = removeTarget;
    busy = e.crc32;
    removeTarget = null;
    try {
      await doEpisodeAction(e.crc32, "remove", { deleteFile: removeFile });
    } finally {
      busy = null;
    }
  }

  async function bulkRetry() {
    const crc32s = retryable.map((e) => e.crc32);
    if (crc32s.length === 0) return;
    bulkBusy = true;
    try {
      // Only clear the selection when everything went; the failures stay
      // selected so the next attempt is one click.
      const r = await doBulkEpisodeAction("retry", crc32s);
      if (r.ok) selected = new Set();
    } finally {
      bulkBusy = false;
    }
  }

  async function confirmBulkRemove() {
    if (typeConfirmRequired && !typeConfirmPassed) return;
    const crc32s = selectedEpisodes.map((e) => e.crc32);
    bulkRemoveOpen = false;
    bulkConfirmText = "";
    if (crc32s.length === 0) return;
    bulkBusy = true;
    try {
      const r = await doBulkEpisodeAction("remove", crc32s, { deleteFile: bulkDeleteFile });
      if (r.ok) selected = new Set();
    } finally {
      bulkBusy = false;
    }
  }

  function openBulkRemove() {
    bulkDeleteFile = false;
    bulkConfirmText = "";
    bulkRemoveOpen = true;
  }

  function closeBulkRemove() {
    bulkRemoveOpen = false;
    bulkConfirmText = "";
  }
</script>

<section class="deck-card card bg-base-100/70">
  <div class="card-body py-4 gap-2">
    <div class="flex items-center justify-between gap-2 flex-wrap">
      <div>
        <div class="eyebrow">Pipeline</div>
        <h2 class="font-display text-lg">Episodes <span class="opacity-50 text-sm font-mono">{$status?.episodes.length ?? 0}</span></h2>
      </div>
      <div class="flex items-center gap-1 flex-wrap">
        {#if selectedEpisodes.length > 0}
          <span class="text-xs opacity-60 font-mono mr-1">{selectedEpisodes.length} selected</span>
          <button
            class="btn btn-xs btn-warning"
            disabled={bulkBusy || retryable.length === 0}
            onclick={bulkRetry}
            title={retryable.length === 0
              ? "None of the selected episodes can be re-queued"
              : `Re-queue ${retryable.length} episode${retryable.length === 1 ? "" : "s"}`}
          >
            {#if bulkBusy}<span class="loading loading-spinner loading-xs"></span>{/if}
            Retry{retryable.length > 0 ? ` (${retryable.length})` : ""}
          </button>
          <button
            class="btn btn-xs btn-error btn-outline"
            disabled={bulkBusy}
            onclick={openBulkRemove}
          >
            Remove ({selectedEpisodes.length})
          </button>
          <button
            class="btn btn-xs btn-ghost"
            disabled={bulkBusy}
            onclick={() => { selected = new Set(); anchor = null; }}
          >
            Clear selection
          </button>
        {:else}
          <button
            class="btn btn-xs btn-ghost"
            class:loading={clearing}
            disabled={clearing || doneCount === 0}
            onclick={clearDone}
            title="Remove completed episodes from the pipeline (files are kept)"
          >
            Clear done{doneCount > 0 ? ` (${doneCount})` : ""}
          </button>
        {/if}
      </div>
    </div>

    <div class="overflow-x-auto max-h-[28rem] rounded-box border border-base-content/5">
      <table class="table table-sm table-pin-rows">
        <thead>
          <tr class="text-xs uppercase tracking-wider">
            <th class="w-8">
              <input
                type="checkbox"
                class="checkbox checkbox-xs"
                checked={allSelected}
                indeterminate={selectedEpisodes.length > 0 && !allSelected}
                onchange={toggleAll}
                disabled={episodes.length === 0}
                aria-label="Select all episodes"
              />
            </th>
            {#each [{ key: "se", label: "S/E", cls: "" }, { key: "arc", label: "Arc", cls: "" }, { key: "status", label: "Status", cls: "" }, { key: "resolution", label: "Res", cls: "hidden md:table-cell" }, { key: "file", label: "File", cls: "hidden lg:table-cell" }, { key: "size", label: "Size", cls: "hidden md:table-cell" }, { key: "updated", label: "Updated", cls: "hidden lg:table-cell" }] as col (col.key)}
              <th class={col.cls} aria-sort={sort.key === col.key ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
                <button
                  class="inline-flex items-center gap-1 uppercase tracking-wider hover:text-primary"
                  class:text-primary={sort.key === col.key}
                  onclick={() => (sort = toggleSort(sort, col.key as SortKey))}
                >
                  {col.label}
                  <!-- Inline SVG rather than ▲/▼/↕: the bundled Chakra Petch and IBM Plex
                       faces have no glyphs for those codepoints, so they would fall back
                       to whatever the OS happens to have (or render as tofu). -->
                  {#if sort.key === col.key && sort.dir === "asc"}
                    <svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" aria-hidden="true">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M12 19V5M5 12l7-7 7 7"/>
                    </svg>
                  {:else if sort.key === col.key}
                    <svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" aria-hidden="true">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M12 5v14M5 12l7 7 7-7"/>
                    </svg>
                  {:else}
                    <svg class="size-3 opacity-40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M8 9l4-4 4 4M8 15l4 4 4-4"/>
                    </svg>
                  {/if}
                </button>
              </th>
            {/each}
            <th class="text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {#each episodes as e, i (e.crc32)}
            {@const file = e.final_filename ?? e.original_filename ?? ""}
            {@const disabled = busy === e.crc32}
            <tr class="hover:bg-base-200/40 {selected.has(e.crc32) ? 'bg-primary/10' : ''}">
              <td>
                <input
                  type="checkbox"
                  class="checkbox checkbox-xs"
                  checked={selected.has(e.crc32)}
                  onclick={(ev) => selectRow(e, i, ev.shiftKey)}
                  aria-label={`Select S${e.arc_part}E${e.episode_num}`}
                />
              </td>
              <td class="font-mono text-primary whitespace-nowrap">S{e.arc_part}E{e.episode_num}</td>
              <td class="max-w-[14rem] truncate font-display">{e.arc_title}</td>
              <td>
                <span class="badge badge-sm {STATUS_BADGE[e.status] ?? 'badge-ghost'}">{e.status}</span>
                {#if e.status === "downloading" && $downloadProgress[e.crc32]}
                  {@const p = $downloadProgress[e.crc32]}
                  <!-- Compact progress for small screens, where the File column is hidden -->
                  <div class="lg:hidden flex flex-col gap-0.5 mt-1 min-w-[6rem]">
                    <progress class="progress progress-info h-1 w-full" value={p.progress} max={1}></progress>
                    <span class="font-mono text-[0.65rem] opacity-60">{Math.round(p.progress * 100)}% · {fmtSpeed(p.dlspeed)}</span>
                  </div>
                {/if}
              </td>
              <td class="hidden md:table-cell font-mono text-xs">{e.resolution}</td>
              <td class="hidden lg:table-cell max-w-xs font-mono text-xs opacity-70">
                {#if e.status === "downloading" && $downloadProgress[e.crc32]}
                  {@const p = $downloadProgress[e.crc32]}
                  <div class="flex flex-col gap-1 min-w-[12rem]">
                    <progress class="progress progress-info h-1.5 w-full" value={p.progress} max={1}></progress>
                    <span>{Math.round(p.progress * 100)}% · {fmtSpeed(p.dlspeed)} · {fmtEta(p.eta)}</span>
                  </div>
                {:else}
                  <span class="truncate block" title={file}>{file}</span>
                {/if}
              </td>
              <td class="hidden md:table-cell whitespace-nowrap font-mono text-xs opacity-60">
                {#if e.status === "downloading" && $downloadProgress[e.crc32]?.size}
                  {fmtBytes($downloadProgress[e.crc32].size)}
                {:else if e.file_size != null}
                  {fmtBytes(e.file_size)}
                {:else}
                  —
                {/if}
              </td>
              <td class="hidden lg:table-cell whitespace-nowrap text-xs opacity-60">{fmtTime(e.updated_at)}</td>
              <td>
                <div class="flex gap-1 justify-end">
                  {#if e.status === "available"}
                    <button class="btn btn-xs btn-primary" {disabled} onclick={() => act(e, "download")}>Download</button>
                  {/if}
                  {#if e.status === "failed"}
                    <button class="btn btn-xs btn-warning" {disabled} onclick={() => act(e, "retry")}>Retry</button>
                  {/if}
                  {#if e.status === "done"}
                    <button class="btn btn-xs btn-ghost" {disabled} onclick={() => act(e, "resync")}>Re-sync</button>
                  {/if}
                  <button class="btn btn-xs btn-ghost text-error" {disabled} onclick={() => askRemove(e)} aria-label="Remove">✕</button>
                </div>
              </td>
            </tr>
          {/each}
          {#if episodes.length === 0}
            <tr><td colspan="9" class="text-center opacity-50 py-6">No episodes tracked yet</td></tr>
          {/if}
        </tbody>
      </table>
    </div>
  </div>
</section>

<!-- Remove confirmation -->
{#if removeTarget}
  <div class="modal modal-open">
    <div class="modal-box deck-card">
      <h3 class="font-display text-lg">Remove episode?</h3>
      <p class="py-2 text-sm">
        <span class="font-mono text-primary">S{removeTarget.arc_part}E{removeTarget.episode_num}</span>
        — {removeTarget.arc_title}. This removes it from tracking.
      </p>
      <label class="label cursor-pointer justify-start gap-3 mt-1">
        <input type="checkbox" class="checkbox checkbox-sm checkbox-error" bind:checked={removeFile} />
        <span class="label-text">Also delete the media file from disk</span>
      </label>
      <div class="modal-action">
        <button class="btn btn-ghost btn-sm" onclick={() => (removeTarget = null)}>Cancel</button>
        <button class="btn btn-error btn-sm" onclick={confirmRemove}>Remove</button>
      </div>
    </div>
    <button class="modal-backdrop" aria-label="Close" onclick={() => (removeTarget = null)}></button>
  </div>
{/if}

<!-- Bulk remove confirmation -->
{#if bulkRemoveOpen}
  <div class="modal modal-open">
    <div class="modal-box deck-card">
      <h3 class="font-display text-lg">Remove {selectedEpisodes.length} episode{selectedEpisodes.length === 1 ? "" : "s"}?</h3>
      <p class="py-2 text-sm">They will be removed from tracking. Any in-flight downloads are cancelled.</p>

      <div class="max-h-40 overflow-y-auto rounded-box border border-base-content/10 my-2">
        <table class="table table-xs">
          <tbody>
            {#each selectedEpisodes as e (e.crc32)}
              <tr>
                <td class="font-mono text-primary whitespace-nowrap w-20">S{e.arc_part}E{e.episode_num}</td>
                <td class="truncate max-w-[16rem]">{e.arc_title}</td>
                <td><span class="badge badge-xs {STATUS_BADGE[e.status] ?? 'badge-ghost'}">{e.status}</span></td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>

      <label class="label cursor-pointer justify-start gap-3">
        <input type="checkbox" class="checkbox checkbox-sm checkbox-error" bind:checked={bulkDeleteFile} />
        <span class="label-text">Also delete the media file{selectedEpisodes.length === 1 ? "" : "s"} from disk</span>
      </label>
      {#if bulkDeleteFile}
        <p class="text-xs text-error">
          {selectedEpisodes.filter((e) => e.final_filename).length} file(s) will be deleted permanently.
        </p>
      {/if}

      {#if typeConfirmRequired}
        <div class="rounded-box border border-error/40 bg-error/5 p-3 my-2">
          <p class="text-xs text-error mb-2">
            This deletes {selectedEpisodes.filter((e) => e.final_filename).length} files at once and cannot be undone.
            Type DELETE to confirm.
          </p>
          <input
            class="input input-sm input-bordered w-full font-mono"
            bind:value={bulkConfirmText}
            placeholder={CONFIRM_WORD}
            autocomplete="off"
          />
        </div>
      {/if}

      <div class="modal-action">
        <button class="btn btn-ghost btn-sm" onclick={closeBulkRemove}>Cancel</button>
        <button
          class="btn btn-error btn-sm"
          disabled={typeConfirmRequired && !typeConfirmPassed}
          onclick={confirmBulkRemove}
        >
          Remove {selectedEpisodes.length}
        </button>
      </div>
    </div>
    <button class="modal-backdrop" aria-label="Close" onclick={closeBulkRemove}></button>
  </div>
{/if}
