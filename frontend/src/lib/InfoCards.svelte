<script lang="ts">
  import { status } from "./stores";
  import { fmtTime, humanCron } from "./util";
</script>

{#snippet card(title: string, rows: [string, string | number | null][])}
  <div class="deck-card card bg-base-100/60">
    <div class="card-body py-4 gap-2">
      <div class="eyebrow">{title}</div>
      <div class="flex flex-col gap-1.5 text-sm">
        {#each rows as [label, value]}
          <div class="flex justify-between gap-4">
            <span class="opacity-50">{label}</span>
            <span class="font-mono text-right truncate">{value ?? "—"}</span>
          </div>
        {/each}
      </div>
    </div>
  </div>
{/snippet}

{#if $status}
  {@const s = $status}
  <div class="grid grid-cols-1 lg:grid-cols-3 gap-3">
    {#if s.plex}
      {@render card("Plex", [["URL", s.plex.plexUrl], ["Library", s.plex.libraryName], ["Show", s.plex.showTitle]])}
    {:else}
      <div class="deck-card card bg-base-100/60">
        <div class="card-body py-4 gap-2">
          <div class="eyebrow">Plex</div>
          <span class="text-error text-sm">Not connected</span>
        </div>
      </div>
    {/if}

    {@render card("qBittorrent · Feed", [
      ["qBit URL", s.config.qbitUrl],
      ["Category", s.config.qbitCategory],
      ["RSS feed", s.config.rssFeedUrl],
      ["Discord", s.config.discordConfigured ? "configured" : "off"],
    ])}

    {@render card("Metadata · Schedule", [
      ["Arcs", s.metadata?.arcs ?? "—"],
      ["Episodes (meta)", s.metadata?.episodes ?? "—"],
      ["Poll", humanCron(s.schedule.pollCron)],
      ["DL check", s.schedule.downloadCheck],
      ["Last poll", fmtTime(s.runtime.lastPollAt)],
      ["Last full sync", fmtTime(s.runtime.lastSyncAt)],
    ])}
  </div>
{/if}
