<script lang="ts">
  import { status, settingsOpen } from "./stores";
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
      <button
        class="btn btn-ghost btn-sm btn-square"
        aria-label="Settings"
        onclick={() => ($settingsOpen = true)}
      >
        <svg xmlns="http://www.w3.org/2000/svg" class="size-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
          <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      </button>
    </div>
  </div>
</header>
