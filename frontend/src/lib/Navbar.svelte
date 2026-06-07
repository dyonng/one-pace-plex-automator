<script lang="ts">
  import { status } from "./stores";
  import { fmtUptime } from "./util";
</script>

<header class="sticky top-0 z-30 border-b border-base-content/10 bg-base-200/70 backdrop-blur-md">
  <div class="max-w-screen-2xl mx-auto px-4 h-14 flex items-center justify-between gap-4">
    <div class="flex items-center gap-3 min-w-0">
      <span class="inline-block size-3 rounded-sm bg-gradient-to-br from-primary to-accent shadow-[0_0_12px] shadow-primary/50"></span>
      <span class="font-display font-bold tracking-wide truncate">ONE PACE <span class="text-primary">·</span> AUTOMATOR</span>
      {#if $status}
        <span class="badge badge-ghost badge-sm font-mono">v{$status.version}</span>
      {/if}
    </div>
    <div class="flex items-center gap-3 shrink-0">
      {#if $status?.busy}
        <span class="badge badge-warning badge-sm gap-1.5">
          <span class="loading loading-spinner loading-xs"></span>
          {$status.busyLabel ?? "working"}
        </span>
      {/if}
      <div class="hidden sm:flex flex-col items-end leading-none">
        <span class="text-[0.6rem] uppercase tracking-widest opacity-50">uptime</span>
        <span class="font-mono text-sm">{$status ? fmtUptime($status.uptimeSec) : "—"}</span>
      </div>
    </div>
  </div>
</header>
