<script lang="ts">
  import { status, doEpisodeAction, downloadProgress } from "./stores";
  import { fmtTime, fmtSpeed, fmtEta, STATUS_BADGE } from "./util";
  import type { Episode } from "./api";

  let busy = $state<string | null>(null);
  let removeTarget = $state<Episode | null>(null);
  let removeFile = $state(false);

  async function act(e: Episode, action: "download" | "retry" | "resync") {
    busy = e.crc32;
    try {
      await doEpisodeAction(e.crc32, action);
    } finally {
      busy = null;
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
</script>

<section class="deck-card card bg-base-100/70">
  <div class="card-body py-4 gap-2">
    <div class="flex items-center justify-between">
      <div>
        <div class="eyebrow">Pipeline</div>
        <h2 class="font-display text-lg">Episodes <span class="opacity-50 text-sm font-mono">{$status?.episodes.length ?? 0}</span></h2>
      </div>
    </div>

    <div class="overflow-x-auto max-h-[28rem] rounded-box border border-base-content/5">
      <table class="table table-sm table-pin-rows">
        <thead>
          <tr class="text-xs uppercase tracking-wider">
            <th>S/E</th><th>Arc</th><th>Status</th><th>Res</th><th>File</th><th>Updated</th><th class="text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {#each $status?.episodes ?? [] as e (e.crc32)}
            {@const file = e.final_filename ?? e.original_filename ?? ""}
            {@const disabled = busy === e.crc32}
            <tr class="hover:bg-base-200/40">
              <td class="font-mono text-primary whitespace-nowrap">S{e.arc_part}E{e.episode_num}</td>
              <td class="max-w-[14rem] truncate font-display">{e.arc_title}</td>
              <td><span class="badge badge-sm {STATUS_BADGE[e.status] ?? 'badge-ghost'}">{e.status}</span></td>
              <td class="font-mono text-xs">{e.resolution}</td>
              <td class="max-w-xs font-mono text-xs opacity-70">
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
              <td class="whitespace-nowrap text-xs opacity-60">{fmtTime(e.updated_at)}</td>
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
          {#if ($status?.episodes.length ?? 0) === 0}
            <tr><td colspan="7" class="text-center opacity-50 py-6">No episodes tracked yet</td></tr>
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
