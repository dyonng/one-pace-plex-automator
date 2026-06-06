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

<div class="card bg-base-100 shadow">
  <div class="card-body py-4">
    <div class="flex items-center justify-between">
      <h2 class="card-title text-base">Logs</h2>
      <label class="label cursor-pointer gap-2 py-0">
        <span class="label-text text-xs">Auto-scroll</span>
        <input type="checkbox" class="toggle toggle-xs" bind:checked={autoscroll} />
      </label>
    </div>
    <div bind:this={box} class="mockup-code text-xs max-h-96 overflow-y-auto bg-base-300">
      {#each $logs as e}
        <pre class="px-2 {LEVEL_CLASS[e.level] ?? ''}"><code>{time(e.ts)} [{e.level.toUpperCase()}] {e.msg}{e.meta ? " " + JSON.stringify(e.meta) : ""}</code></pre>
      {/each}
    </div>
  </div>
</div>
