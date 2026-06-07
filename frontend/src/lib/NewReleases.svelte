<script lang="ts">
  import { status, doEpisodeAction } from "./stores";
  import type { Episode } from "./api";

  let busy = $state<string | null>(null);

  const available = $derived(($status?.episodes ?? []).filter((e) => e.status === "available"));

  async function download(e: Episode) {
    busy = e.crc32;
    try {
      await doEpisodeAction(e.crc32, "download");
    } finally {
      busy = null;
    }
  }
</script>

{#if available.length > 0}
  <section class="deck-card card bg-base-100/70 overflow-hidden">
    <!-- accent rail -->
    <div class="h-1 w-full bg-gradient-to-r from-primary via-accent to-transparent"></div>
    <div class="card-body py-4 gap-3">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2">
          <span class="eyebrow">Awaiting your call</span>
          <span class="badge badge-primary badge-sm font-mono">{available.length}</span>
        </div>
        <span class="text-xs opacity-60">auto-download is off</span>
      </div>
      <h2 class="font-display text-xl">New Releases</h2>

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-3 mt-1">
        {#each available as e (e.crc32)}
          {@const isRerelease = e.changelog.length > 0}
          <div class="rounded-box border border-base-content/10 bg-base-200/60 p-3 flex flex-col gap-2">
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <div class="flex items-center gap-2">
                  <span class="font-mono text-primary font-medium">S{e.arc_part}E{e.episode_num}</span>
                  <span class="truncate font-display">{e.arc_title}</span>
                </div>
                <div class="flex items-center gap-2 mt-1">
                  <span class="badge badge-xs badge-ghost font-mono">{e.resolution}</span>
                  {#if isRerelease}
                    <span class="badge badge-xs badge-accent">re-release</span>
                  {:else}
                    <span class="badge badge-xs badge-success badge-soft">new</span>
                  {/if}
                  <span class="font-mono text-[0.65rem] opacity-50">{e.crc32}</span>
                </div>
              </div>
              <button
                class="btn btn-primary btn-sm gap-1 shrink-0"
                disabled={busy === e.crc32}
                onclick={() => download(e)}
              >
                {#if busy === e.crc32}<span class="loading loading-spinner loading-xs"></span>{/if}
                Download
              </button>
            </div>

            {#if isRerelease}
              <ul class="text-xs opacity-75 list-disc list-inside marker:text-accent space-y-0.5">
                {#each e.changelog as line}<li>{line}</li>{/each}
              </ul>
            {/if}
          </div>
        {/each}
      </div>
    </div>
  </section>
{/if}
