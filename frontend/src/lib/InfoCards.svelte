<script lang="ts">
  import { status } from "./stores";
  import { fmtTime } from "./util";
</script>

{#if $status}
  {@const s = $status}
  <div class="grid grid-cols-1 lg:grid-cols-3 gap-4">
    <div class="card bg-base-100 shadow">
      <div class="card-body py-4">
        <h2 class="card-title text-base">Plex</h2>
        <div class="text-sm font-mono break-all flex flex-col gap-1">
          {#if s.plex}
            <div class="flex justify-between gap-4"><span class="opacity-60">URL</span><span>{s.plex.plexUrl}</span></div>
            <div class="flex justify-between gap-4"><span class="opacity-60">Library</span><span>{s.plex.libraryName}</span></div>
            <div class="flex justify-between gap-4"><span class="opacity-60">Show</span><span>{s.plex.showTitle}</span></div>
          {:else}
            <span class="text-error">Not connected</span>
          {/if}
        </div>
      </div>
    </div>

    <div class="card bg-base-100 shadow">
      <div class="card-body py-4">
        <h2 class="card-title text-base">qBittorrent &amp; Feed</h2>
        <div class="text-sm font-mono break-all flex flex-col gap-1">
          <div class="flex justify-between gap-4"><span class="opacity-60">qBit URL</span><span>{s.config.qbitUrl}</span></div>
          <div class="flex justify-between gap-4"><span class="opacity-60">Category</span><span>{s.config.qbitCategory}</span></div>
          <div class="flex justify-between gap-4"><span class="opacity-60">RSS feed</span><span>{s.config.rssFeedUrl}</span></div>
          <div class="flex justify-between gap-4"><span class="opacity-60">Discord</span><span>{s.config.discordConfigured ? "configured" : "off"}</span></div>
        </div>
      </div>
    </div>

    <div class="card bg-base-100 shadow">
      <div class="card-body py-4">
        <h2 class="card-title text-base">Metadata &amp; Schedule</h2>
        <div class="text-sm font-mono break-all flex flex-col gap-1">
          <div class="flex justify-between gap-4"><span class="opacity-60">Arcs</span><span>{s.metadata?.arcs ?? "—"}</span></div>
          <div class="flex justify-between gap-4"><span class="opacity-60">Episodes (meta)</span><span>{s.metadata?.episodes ?? "—"}</span></div>
          <div class="flex justify-between gap-4"><span class="opacity-60">Poll cron</span><span>{s.schedule.pollCron}</span></div>
          <div class="flex justify-between gap-4"><span class="opacity-60">DL check</span><span>{s.schedule.downloadCheck}</span></div>
          <div class="flex justify-between gap-4"><span class="opacity-60">Last poll</span><span>{fmtTime(s.runtime.lastPollAt)}</span></div>
          <div class="flex justify-between gap-4"><span class="opacity-60">Last full sync</span><span>{fmtTime(s.runtime.lastSyncAt)}</span></div>
          <div class="flex justify-between gap-4"><span class="opacity-60">Last meta refresh</span><span>{fmtTime(s.runtime.lastRefreshAt)}</span></div>
        </div>
      </div>
    </div>
  </div>
{/if}
