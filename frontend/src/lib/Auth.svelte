<script lang="ts">
  import { auth, loadAuth, toast } from "./stores";
  import { setAuthPassword, toggleAuth } from "./api";

  let newPw = $state("");
  let confirmPw = $state("");
  let busy = $state(false);
  let confirmDisable = $state(false);

  async function savePassword() {
    if (newPw.length < 6) return toast("Password must be at least 6 characters", false);
    if (newPw !== confirmPw) return toast("Passwords do not match", false);
    busy = true;
    try {
      const r = await setAuthPassword(newPw);
      toast(r.message, r.ok);
      if (r.ok) {
        newPw = "";
        confirmPw = "";
        await loadAuth();
      }
    } finally {
      busy = false;
    }
  }

  async function onToggle(ev: Event) {
    const wantEnabled = (ev.currentTarget as HTMLInputElement).checked;
    if (!wantEnabled) {
      // Disabling exposes controls — confirm first; revert the checkbox until confirmed.
      (ev.currentTarget as HTMLInputElement).checked = true;
      confirmDisable = true;
      return;
    }
    busy = true;
    try {
      const r = await toggleAuth(true);
      toast(r.message + (r.ok ? " — you may be prompted to log in" : ""), r.ok);
      await loadAuth();
    } finally {
      busy = false;
    }
  }

  async function doDisable() {
    confirmDisable = false;
    busy = true;
    try {
      const r = await toggleAuth(false);
      toast(r.message, r.ok);
      await loadAuth();
    } finally {
      busy = false;
    }
  }
</script>

<section class="deck-card card bg-base-100/70">
  <div class="card-body py-4 gap-3">
    <div>
      <div class="eyebrow">Security</div>
      <h2 class="font-display text-lg">Authentication</h2>
    </div>

    {#if $auth}
      <!-- State + toggle -->
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="flex items-center gap-2">
          {#if $auth.enabled}
            <span class="badge badge-success gap-1.5"><span class="size-2 rounded-full bg-success-content/70"></span>Protected</span>
          {:else}
            <span class="badge badge-error gap-1.5"><span class="size-2 rounded-full bg-error-content/70"></span>Open — no auth</span>
          {/if}
          {#if !$auth.hasPassword}
            <span class="text-xs opacity-60">no password set</span>
          {/if}
        </div>
        <label class="label cursor-pointer gap-3">
          <span class="label-text text-sm">Require authentication</span>
          <input
            type="checkbox"
            class="toggle toggle-primary"
            checked={$auth.enabled}
            disabled={busy || (!$auth.hasPassword && !$auth.enabled)}
            onchange={onToggle}
          />
        </label>
      </div>

      {#if !$auth.hasPassword}
        <div class="alert alert-warning text-sm py-2">
          <span>Set a password below to enable authentication.</span>
        </div>
      {/if}

      <div class="divider my-0 opacity-40"></div>

      <!-- Set / change password -->
      <div class="flex flex-col gap-2 max-w-md">
        <span class="text-sm opacity-70">{$auth.hasPassword ? "Change password" : "Set password"}</span>
        <input
          class="input input-bordered input-sm font-mono"
          type="password"
          placeholder="New password (min 6 chars)"
          autocomplete="new-password"
          bind:value={newPw}
        />
        <input
          class="input input-bordered input-sm font-mono"
          type="password"
          placeholder="Confirm password"
          autocomplete="new-password"
          bind:value={confirmPw}
        />
        <button class="btn btn-primary btn-sm w-fit" disabled={busy || !newPw} onclick={savePassword}>
          {$auth.hasPassword ? "Update password" : "Set password"}
        </button>
        <p class="text-xs opacity-50">
          Stored as a salted scrypt hash — the plaintext is never saved. Login is HTTP Basic auth
          (sent base64, not encrypted) — use a TLS reverse proxy if exposing beyond your LAN.
        </p>
      </div>
    {/if}
  </div>
</section>

<!-- Disable confirmation -->
{#if confirmDisable}
  <div class="modal modal-open">
    <div class="modal-box deck-card">
      <h3 class="font-display text-lg text-error">Disable authentication?</h3>
      <p class="py-2 text-sm">
        Anyone who can reach this dashboard will have full control — start/delete downloads, edit
        settings, write to Plex. Only do this on a trusted network.
      </p>
      <div class="modal-action">
        <button class="btn btn-ghost btn-sm" onclick={() => (confirmDisable = false)}>Cancel</button>
        <button class="btn btn-error btn-sm" onclick={doDisable}>Disable auth</button>
      </div>
    </div>
    <button class="modal-backdrop" aria-label="Close" onclick={() => (confirmDisable = false)}></button>
  </div>
{/if}
