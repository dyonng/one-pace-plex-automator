<script lang="ts">
  import { onMount } from "svelte";
  import { startPolling, startProgressPolling, initLogs, streamLogs, loadSettings, loadAuth, loadCoverage } from "./lib/stores";
  import Navbar from "./lib/Navbar.svelte";
  import NewReleases from "./lib/NewReleases.svelte";
  import Controls from "./lib/Controls.svelte";
  import System from "./lib/System.svelte";
  import Coverage from "./lib/Coverage.svelte";
  import InfoCards from "./lib/InfoCards.svelte";
  import Settings from "./lib/Settings.svelte";
  import Episodes from "./lib/Episodes.svelte";
  import Logs from "./lib/Logs.svelte";
  import Toasts from "./lib/Toasts.svelte";

  onMount(() => {
    const poll = startPolling();
    const progressPoll = startProgressPolling();
    loadSettings();
    loadAuth();
    loadCoverage();
    initLogs();
    const es = streamLogs();
    return () => {
      clearInterval(poll);
      clearInterval(progressPoll);
      es.close();
    };
  });
</script>

<Navbar />
<main class="p-4 sm:p-6 max-w-screen-2xl mx-auto flex flex-col gap-4">
  <NewReleases />
  <System />
  <Controls />
  <Coverage />
  <InfoCards />
  <Settings />
  <Episodes />
  <Logs />
</main>
<Toasts />
