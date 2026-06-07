<script lang="ts">
  import { settings, loadSettings, toast, refreshStatus } from "./stores";
  import { saveSetting, resetSettingReq } from "./api";
  import { humanCron } from "./util";

  let edited = $state<Record<string, string>>({});
  let saving = $state<string | null>(null);

  $effect(() => {
    for (const s of $settings) {
      if (s.type !== "bool" && !(s.key in edited)) edited[s.key] = s.value;
    }
  });

  async function persist(key: string, value: string) {
    saving = key;
    try {
      const r = await saveSetting(key, value);
      toast(r.message, r.ok);
      if (r.ok) {
        await loadSettings();
        refreshStatus();
      }
    } finally {
      saving = null;
    }
  }

  async function reset(key: string) {
    saving = key;
    try {
      const r = await resetSettingReq(key);
      toast(r.message, r.ok);
      if (r.ok) {
        delete edited[key];
        await loadSettings();
        refreshStatus();
      }
    } finally {
      saving = null;
    }
  }
</script>

<section class="deck-card card bg-base-100/70">
  <div class="card-body py-4 gap-3">
    <div>
      <div class="eyebrow">Configuration</div>
      <h2 class="font-display text-lg">Settings</h2>
      <p class="text-xs opacity-55">Overrides persist and win over env. Secrets &amp; paths stay env-only.</p>
    </div>

    <div class="flex flex-col divide-y divide-base-content/5">
      {#each $settings as s (s.key)}
        <div class="flex flex-wrap items-center gap-3 py-3">
          <div class="flex-1 min-w-[12rem]">
            <div class="flex items-center gap-2">
              <span class="text-sm">{s.label}</span>
              {#if s.overridden}
                <span class="badge badge-warning badge-xs">override</span>
              {:else}
                <span class="badge badge-ghost badge-xs">env</span>
              {/if}
            </div>
            {#if s.overridden && s.type !== "bool"}
              <span class="text-xs opacity-45 font-mono">env: {s.envValue || "(empty)"}</span>
            {/if}
          </div>

          {#if s.type === "bool"}
            <input
              type="checkbox"
              class="toggle toggle-primary"
              checked={s.value === "true"}
              disabled={saving === s.key}
              onchange={(ev) => persist(s.key, (ev.currentTarget as HTMLInputElement).checked ? "true" : "false")}
            />
            {#if s.overridden}
              <button class="btn btn-ghost btn-xs" onclick={() => reset(s.key)}>reset</button>
            {/if}
          {:else}
            <input
              class="input input-bordered input-sm w-full sm:w-72 font-mono"
              type={s.type === "int" ? "number" : "text"}
              bind:value={edited[s.key]}
              placeholder={s.envValue || "(empty)"}
            />
            <div class="flex gap-1">
              <button class="btn btn-primary btn-sm" disabled={saving === s.key} onclick={() => persist(s.key, edited[s.key] ?? "")}>Save</button>
              <button class="btn btn-ghost btn-sm" disabled={saving === s.key || !s.overridden} onclick={() => reset(s.key)}>Reset</button>
            </div>
            {#if s.type === "cron"}
              <div class="basis-full text-xs text-primary/80 font-display tracking-wide">↳ {humanCron(edited[s.key])}</div>
            {/if}
          {/if}
        </div>
      {/each}
    </div>
  </div>
</section>
