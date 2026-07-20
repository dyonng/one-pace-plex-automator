<script lang="ts">
  import { status, settingsOpen, changelogOpen } from "./stores";
  import { fmtUptime } from "./util";
  import { logo, logoUrl } from "./logo";
</script>

<header class="sticky top-0 z-30 border-b border-base-content/10 bg-base-200/70 backdrop-blur-md">
  <div class="max-w-screen-2xl mx-auto px-4 h-14 flex items-center justify-between gap-4">
    <div class="flex items-center gap-3 min-w-0">
      <img src={logoUrl($logo)} alt="" class="size-7 shrink-0" />
      <span class="font-display font-bold tracking-wide truncate">ONE PACE<span class="hidden sm:inline"> <span class="text-primary">·</span> AUTOMATOR</span></span>
      {#if $status}
        <div
          class="tooltip tooltip-bottom"
          data-tip={$status.updateAvailable
            ? `v${$status.updateAvailable} available — pull the new image. Click for changelog.`
            : "View changelog"}
        >
          <button
            class="btn btn-xs btn-ghost border gap-1 font-mono normal-case relative {$status.updateAvailable
              ? 'border-warning/60 text-warning hover:border-warning'
              : 'border-base-content/20 hover:border-base-content/40'}"
            onclick={() => ($changelogOpen = true)}
          >
            <svg class="size-3 opacity-60" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M12 8v4l2.5 2.5M21 12a9 9 0 11-9-9c2.52 0 4.8 1.04 6.44 2.72L21 8.25M21 3v5.25h-5.25"/>
            </svg>
            v{$status.version}
            {#if $status.updateAvailable}
              <span class="absolute -top-1 -right-1 flex size-2">
                <span class="animate-ping absolute inline-flex size-full rounded-full bg-warning opacity-75"></span>
                <span class="relative inline-flex size-2 rounded-full bg-warning"></span>
              </span>
            {/if}
          </button>
        </div>
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
