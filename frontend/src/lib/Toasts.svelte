<script lang="ts">
  import { toasts } from "./stores";
</script>

<div class="toast toast-end z-50">
  {#each $toasts as t (t.id)}
    <div class="alert deck-card {t.ok ? 'alert-success' : 'alert-error'} text-sm py-2">
      <span class="font-mono text-xs opacity-70">{t.ok ? "✓" : "✕"}</span>
      <span>{t.msg}</span>
    </div>
  {/each}
</div>
