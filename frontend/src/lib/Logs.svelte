<script lang="ts">
  import { tick } from "svelte";
  import { logs, clearLogs } from "./stores";
  import { LEVEL_CLASS } from "./util";

  let autoscroll = $state(true);
  let box = $state<HTMLDivElement | null>(null);

  // Client-side filters — the full history stays in the store.
  let levelFilter = $state<"all" | "info" | "warn" | "error">("all");
  let textFilter = $state("");

  const filtered = $derived.by(() => {
    const q = textFilter.trim().toLowerCase();
    return $logs.filter((e) => {
      if (levelFilter === "warn" && e.level !== "warn" && e.level !== "error") return false;
      if (levelFilter === "error" && e.level !== "error") return false;
      if (levelFilter === "info" && e.level === "debug") return false;
      if (!q) return true;
      const meta = e.meta ? JSON.stringify(e.meta) : "";
      return (e.msg + " " + meta).toLowerCase().includes(q);
    });
  });

  // Auto-scroll to bottom whenever the visible logs change (if enabled).
  $effect(() => {
    filtered; // track
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
    <div class="flex items-center justify-between gap-3 flex-wrap">
      <div>
        <div class="eyebrow">Telemetry</div>
        <h2 class="font-display text-lg">Logs</h2>
      </div>
      <div class="flex items-center gap-2 flex-wrap">
        <input
          class="input input-xs input-bordered font-mono w-44"
          placeholder="Filter…"
          bind:value={textFilter}
        />
        <select class="select select-xs select-bordered" bind:value={levelFilter}>
          <option value="all">All levels</option>
          <option value="info">Info+</option>
          <option value="warn">Warn+</option>
          <option value="error">Errors</option>
        </select>
        <button
          class="btn btn-xs btn-ghost opacity-60 hover:opacity-100"
          onclick={clearLogs}
          disabled={$logs.length === 0}
        >
          Clear
        </button>
        <label class="label cursor-pointer gap-2 py-0">
          <span class="label-text text-xs">Auto-scroll</span>
          <input type="checkbox" class="toggle toggle-xs toggle-primary" bind:checked={autoscroll} />
        </label>
      </div>
    </div>
    <div
      bind:this={box}
      class="text-xs h-96 overflow-y-auto rounded-box border border-base-content/10 bg-base-300/50 p-2 font-mono leading-relaxed"
    >
      {#each filtered as e}
        <pre class="px-1 whitespace-pre-wrap break-words"><span class="opacity-40">{time(e.ts)}</span> <span class="{LEVEL_CLASS[e.level] ?? ''}">[{e.level.toUpperCase()}]</span> {e.msg}{e.meta ? " " + JSON.stringify(e.meta) : ""}</pre>
      {/each}
      {#if filtered.length === 0}
        <div class="opacity-40 px-1 py-4 text-center">
          {$logs.length === 0 ? "waiting for events…" : `no matches (${$logs.length} hidden by filter)`}
        </div>
      {/if}
    </div>
    {#if filtered.length !== $logs.length && filtered.length > 0}
      <p class="text-[0.65rem] opacity-40">Showing {filtered.length} of {$logs.length} entries</p>
    {/if}
  </div>
</section>
