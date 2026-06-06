<script lang="ts">
  import { toasts } from "./stores";
</script>

<div class="toast toast-end">
  {#each $toasts as t (t.id)}
    <div class="alert {t.ok ? 'alert-success' : 'alert-error'}">
      <span>{t.msg}</span>
    </div>
  {/each}
</div>
