<script lang="ts">
  import { status } from "./stores";
  import { fmtTime, humanCron } from "./util";
</script>

{#snippet item(label: string, value: string | number | null, error = false)}
  <span class="whitespace-nowrap">
    <span class="opacity-50">{label} </span><span
      class="font-mono"
      class:text-error={error}
    >
      {value ?? "—"}
    </span>
  </span>
{/snippet}

{#if $status}
  {@const s = $status}
  <footer class="flex flex-wrap items-center gap-x-5 gap-y-1 px-1 pt-1 text-xs opacity-60">
    {#if s.plex}
      {@render item("Plex", `${s.plex.plexUrl} · ${s.plex.libraryName} · ${s.plex.showTitle}`)}
    {:else}
      {@render item("Plex", "not connected", true)}
    {/if}
    {@render item("qBit", `${s.config.qbitUrl} · ${s.config.qbitCategory}`)}
    {@render item("Feed", s.config.rssFeedUrl)}
    {@render item("Discord", s.config.discordConfigured ? "on" : "off")}
    {@render item("Catalog", `${s.metadata?.arcs ?? "—"} arcs · ${s.metadata?.episodes ?? "—"} eps`)}
    {@render item("Poll", `${humanCron(s.schedule.pollCron)} · DL ${s.schedule.downloadCheck}`)}
    {@render item("Last poll", fmtTime(s.runtime.lastPollAt))}
    {@render item("Last sync", fmtTime(s.runtime.lastSyncAt))}
  </footer>
{/if}
