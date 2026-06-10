<script lang="ts">
  import { settings, loadSettings, toast, refreshStatus, settingsOpen } from "./stores";
  import { saveSetting, resetSettingReq, testDiscordReq, type SettingView } from "./api";
  import { humanCron } from "./util";
  import Auth from "./Auth.svelte";

  let dialogEl = $state<HTMLDialogElement | null>(null);
  let edited = $state<Record<string, string>>({});
  let saving = $state<string | null>(null);
  let testing = $state(false);

  const serviceSettings = $derived($settings.filter((s) => s.category === "service"));
  const preferenceSettings = $derived($settings.filter((s) => s.category === "preference"));

  $effect(() => {
    if ($settingsOpen) dialogEl?.showModal();
    else dialogEl?.close();
  });

  $effect(() => {
    for (const s of $settings) {
      if (s.type !== "bool" && !(s.key in edited)) edited[s.key] = s.value;
    }
  });

  function close() { $settingsOpen = false; }

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

  async function testDiscord() {
    testing = true;
    try {
      const r = await testDiscordReq();
      toast(r.message, r.ok);
    } finally {
      testing = false;
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

<dialog bind:this={dialogEl} class="modal" onclose={close}>
  <div class="modal-box max-w-2xl w-full max-h-[85vh] overflow-y-auto deck-card flex flex-col gap-4">
    <div class="flex items-start justify-between">
      <div>
        <div class="eyebrow">Configuration</div>
        <h2 class="font-display text-lg">Settings</h2>
        <p class="text-xs opacity-55">Overrides persist and win over env. Secrets &amp; paths stay env-only.</p>
      </div>
      <button class="btn btn-sm btn-circle btn-ghost" onclick={close}>✕</button>
    </div>

    <div class="flex flex-col gap-4">
      <div>
        <h3 class="text-xs uppercase tracking-wider opacity-60 mb-1">System &amp; Services</h3>
        <div class="flex flex-col divide-y divide-base-content/5">
          {#each serviceSettings as s (s.key)}
            {@render settingRow(s)}
          {/each}
        </div>
      </div>
      <div>
        <h3 class="text-xs uppercase tracking-wider opacity-60 mb-1">Preferences</h3>
        <div class="flex flex-col divide-y divide-base-content/5">
          {#each preferenceSettings as s (s.key)}
            {@render settingRow(s)}
          {/each}
        </div>
      </div>
    </div>

    <div class="divider my-0 opacity-30"></div>
    <Auth />
  </div>
  <form method="dialog" class="modal-backdrop"><button onclick={close}>close</button></form>
</dialog>

{#snippet settingRow(s: SettingView)}
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
      {#if s.key === "DISCORD_WEBHOOK_URL"}
        <button
          class="btn btn-secondary btn-sm"
          disabled={testing || !s.value}
          title={s.value ? "Sends a test message to the saved webhook" : "Save a webhook URL first"}
          onclick={testDiscord}>{testing ? "Testing…" : "Test"}</button>
      {/if}
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
      {#if s.key === "DISCORD_WEBHOOK_URL" && (edited[s.key] ?? "") !== s.value}
        <div class="basis-full text-xs opacity-55">↳ Test uses the saved value — Save first to test your edit.</div>
      {/if}
      {#if s.type === "cron"}
        <div class="basis-full text-xs text-primary/80 font-display tracking-wide">↳ {humanCron(edited[s.key])}</div>
      {/if}
    {/if}
  </div>
{/snippet}
