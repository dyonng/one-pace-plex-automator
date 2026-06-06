<script lang="ts">
  import { status } from "./stores";
  import { fmtTime, STATUS_BADGE } from "./util";
</script>

{#if $status}
  <div class="card bg-base-100 shadow">
    <div class="card-body py-4">
      <h2 class="card-title text-base">Episodes ({$status.episodes.length})</h2>
      <div class="overflow-x-auto max-h-96">
        <table class="table table-xs table-pin-rows">
          <thead>
            <tr>
              <th>S/E</th><th>Arc</th><th>Status</th><th>Res</th><th>CRC32</th><th>File</th><th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {#each $status.episodes as e (e.crc32)}
              {@const file = e.final_filename ?? e.original_filename ?? ""}
              <tr>
                <td class="font-mono">S{e.arc_part}E{e.episode_num}</td>
                <td>{e.arc_title}</td>
                <td><span class="badge badge-sm {STATUS_BADGE[e.status] ?? 'badge-ghost'}">{e.status}</span></td>
                <td>{e.resolution}</td>
                <td class="font-mono">{e.crc32}</td>
                <td class="max-w-xs truncate" title={file}>{file}</td>
                <td class="whitespace-nowrap">{fmtTime(e.updated_at)}</td>
              </tr>
            {/each}
            {#if $status.episodes.length === 0}
              <tr><td colspan="7" class="text-center opacity-60">No episodes tracked yet</td></tr>
            {/if}
          </tbody>
        </table>
      </div>
    </div>
  </div>
{/if}
