<script lang="ts">
  import { tick } from "svelte";
  import { logs } from "./stores";
  import { LEVEL_CLASS } from "./util";

  let autoscroll = $state(true);
  let box = $state<HTMLDivElement | null>(null);

  // Auto-scroll to bottom whenever logs change (if enabled).
  $effect(() => {
    $logs; // track
    if (autoscroll && box) {
      tick().then(() => {
        if (box) box.scrollTop = box.scrollHeight;
      });
    }
  });

  const time = (ts: number) => new Date(ts).toLocaleTimeString();
</script>

<section class="deck-card card bg-base-100/70">
  <div class="card-body py-4 gap-2">
    <div class="flex items-center justify-between">
      <div>
        <div class="eyebrow">Telemetry</div>
        <h2 class="font-display text-lg">Logs</h2>
      </div>
      <label class="label cursor-pointer gap-2 py-0">
        <span class="label-text text-xs">Auto-scroll</span>
        <input type="checkbox" class="toggle toggle-xs toggle-primary" bind:checked={autoscroll} />
      </label>
    </div>
    <div
      bind:this={box}
      class="text-xs h-96 overflow-y-auto rounded-box border border-base-content/10 bg-base-300/50 p-2 font-mono leading-relaxed"
    >
      {#each $logs as e}
        <pre class="px-1 whitespace-pre-wrap break-words"><span class="opacity-40">{time(e.ts)}</span> <span class="{LEVEL_CLASS[e.level] ?? ''}">[{e.level.toUpperCase()}]</span> {e.msg}{e.meta ? " " + JSON.stringify(e.meta) : ""}</pre>
      {/each}
      {#if $logs.length === 0}
        <div class="opacity-40 px-1 py-4 text-center">waiting for events…</div>
      {/if}
    </div>
  </div>
</section>
