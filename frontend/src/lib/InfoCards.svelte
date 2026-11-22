<script lang="ts">
  import { status } from "./stores";
  import { fmtTime, humanCron } from "./util";
</script>

{#snippet cluster(title: string, rows: [string, string | number | null, boolean?][])}
  <div class="flex flex-col gap-1.5 min-w-0">
    <div class="text-[0.65rem] uppercase tracking-wider opacity-50">{title}</div>
    <div class="flex flex-col gap-1 text-xs">
      {#each rows as [label, value, error]}
        <div class="flex justify-between gap-4">
          <span class="opacity-50 shrink-0">{label}</span>
          <span class="font-mono text-right truncate" class:text-error={error === true}>
            {value ?? "—"}
          </span>
        </div>
      {/each}
    </div>
  </div>
{/snippet}

{#if $status}
  {@const s = $status}
  <footer class="deck-card card bg-base-100/60">
    <div class="card-body p-4 gap-4">
      <div class="eyebrow">Configuration</div>
      <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-x-8 gap-y-4">
        {#if s.plex}
          {@render cluster("Plex", [
            ["URL", s.plex.plexUrl],
            ["Library", s.plex.libraryName],
            ["Show", s.plex.showTitle],
          ])}
        {:else}
          {@render cluster("Plex", [["Status", "not connected", true]])}
        {/if}
        {@render cluster("Downloads & feed", [
          ["qBit URL", s.config.qbitUrl],
          ["Category", s.config.qbitCategory],
          ["RSS feed", s.config.rssFeedUrl],
          ["Discord", s.config.discordConfigured ? "on" : "off"],
        ])}
        {@render cluster("Catalog", [
          ["Arcs", s.metadata?.arcs ?? "—"],
          ["Episodes", s.metadata?.episodes ?? "—"],
        ])}
        {@render cluster("Schedule", [
          ["Poll", humanCron(s.schedule.pollCron)],
          ["DL check", s.schedule.downloadCheck],
          ["Last poll", fmtTime(s.runtime.lastPollAt)],
          ["Last sync", fmtTime(s.runtime.lastSyncAt)],
        ])}
      </div>
    </div>
  </footer>
{/if}
