<script lang="ts">
  import { status } from "./stores";
  import { fmtUptime } from "./util";
</script>

<div class="navbar bg-base-300 shadow">
  <div class="flex-1 px-2 gap-2">
    <span class="text-lg font-bold">One Pace Plex Automator</span>
    {#if $status}
      <span class="badge badge-neutral badge-sm">v{$status.version}</span>
    {/if}
  </div>
  <div class="flex-none gap-2 px-2 items-center">
    {#if $status?.busy}
      <span class="badge badge-warning badge-sm">Running: {$status.busyLabel ?? "…"}</span>
    {/if}
    <span class="text-sm opacity-70">uptime</span>
    <span class="text-sm font-mono">{$status ? fmtUptime($status.uptimeSec) : "—"}</span>
  </div>
</div>
