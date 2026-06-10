<script lang="ts">
  import { settings, loadSettings, toast, refreshStatus, settingsOpen } from "./stores";
  import { saveSetting, resetSettingReq, testDiscordReq, type SettingView } from "./api";
  import { humanCron } from "./util";
  import Auth from "./Auth.svelte";
  import { themePref, customTheme, DAISYUI_THEMES } from "./theme";

  const themeOptions = [
    { value: "auto",  label: "Auto" },
    { value: "light", label: "Light" },
    { value: "dark",  label: "Dark" },
    { value: "other", label: "Other" },
  ] as const;

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
      <!-- Appearance -->
      <div>
        <h3 class="text-xs uppercase tracking-wider opacity-60 mb-2">Appearance</h3>
        <div class="join">
          {#each themeOptions as opt (opt.value)}
            <button
              class="join-item btn btn-sm gap-1.5 {$themePref === opt.value ? 'btn-primary' : 'btn-ghost opacity-60 hover:opacity-100'}"
              onclick={() => ($themePref = opt.value)}
            >
              {#if opt.value === "auto"}
                <svg class="size-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                  <rect x="2" y="3" width="20" height="14" rx="2"/>
                  <path stroke-linecap="round" d="M8 21h8M12 17v4"/>
                </svg>
              {:else if opt.value === "light"}
                <svg class="size-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                  <circle cx="12" cy="12" r="4"/>
                  <path stroke-linecap="round" d="M12 2v2M12 20v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M2 12h2M20 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>
                </svg>
              {:else if opt.value === "dark"}
                <svg class="size-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/>
                </svg>
              {:else}
                <svg class="size-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                  <circle cx="12" cy="12" r="3"/><path stroke-linecap="round" d="M12 2v2M12 20v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M2 12h2M20 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/><path stroke-linecap="round" d="M17 7l-2 2M9 15l-2 2"/>
                </svg>
              {/if}
              {opt.label}
            </button>
          {/each}
        </div>
        {#if $themePref === "other"}
          <select
            class="select select-bordered select-sm mt-2 w-full sm:w-56 font-mono capitalize"
            bind:value={$customTheme}
          >
            {#each DAISYUI_THEMES as t (t)}
              <option value={t}>{t}</option>
            {/each}
          </select>
        {/if}
        <p class="text-xs opacity-45 mt-1.5">Auto follows your system preference; falls back to Dark.</p>
      </div>

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
