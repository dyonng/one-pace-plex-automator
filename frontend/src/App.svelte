<script lang="ts">
  import { onMount } from "svelte";
  import { startPolling, initLogs, streamLogs } from "./lib/stores";
  import Navbar from "./lib/Navbar.svelte";
  import Controls from "./lib/Controls.svelte";
  import Stats from "./lib/Stats.svelte";
  import InfoCards from "./lib/InfoCards.svelte";
  import Episodes from "./lib/Episodes.svelte";
  import Logs from "./lib/Logs.svelte";
  import Toasts from "./lib/Toasts.svelte";

  onMount(() => {
    const poll = startPolling();
    initLogs();
    const es = streamLogs();
    return () => {
      clearInterval(poll);
      es.close();
    };
  });
</script>

<Navbar />
<main class="p-4 max-w-screen-2xl mx-auto flex flex-col gap-4">
  <Controls />
  <Stats />
  <InfoCards />
  <Episodes />
  <Logs />
</main>
<Toasts />
