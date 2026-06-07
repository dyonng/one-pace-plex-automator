<script lang="ts">
  import { onMount } from "svelte";
  import { startPolling, initLogs, streamLogs, loadSettings, loadAuth } from "./lib/stores";
  import Navbar from "./lib/Navbar.svelte";
  import NewReleases from "./lib/NewReleases.svelte";
  import Controls from "./lib/Controls.svelte";
  import Stats from "./lib/Stats.svelte";
  import InfoCards from "./lib/InfoCards.svelte";
  import Settings from "./lib/Settings.svelte";
  import Episodes from "./lib/Episodes.svelte";
  import Logs from "./lib/Logs.svelte";
  import Auth from "./lib/Auth.svelte";
  import Toasts from "./lib/Toasts.svelte";

  onMount(() => {
    const poll = startPolling();
    loadSettings();
    loadAuth();
    initLogs();
    const es = streamLogs();
    return () => {
      clearInterval(poll);
      es.close();
    };
  });
</script>

<Navbar />
<main class="p-4 sm:p-6 max-w-screen-2xl mx-auto flex flex-col gap-4">
  <NewReleases />
  <Stats />
  <Controls />
  <InfoCards />
  <Settings />
  <Episodes />
  <Logs />
  <Auth />
</main>
<Toasts />
