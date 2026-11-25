<script lang="ts">
  import { onMount } from "svelte";
  import { startPolling, startProgressPolling, initLogs, streamLogs, loadSettings, loadAuth, loadCoverage, loadMetadataAudit } from "./lib/stores";
  import Navbar from "./lib/Navbar.svelte";
  import AttentionBanner from "./lib/AttentionBanner.svelte";
  import NewReleases from "./lib/NewReleases.svelte";
  import Controls from "./lib/Controls.svelte";
  import System from "./lib/System.svelte";
  import Library from "./lib/Library.svelte";
  import InfoCards from "./lib/InfoCards.svelte";
  import Settings from "./lib/Settings.svelte";
  import WhatsNew from "./lib/WhatsNew.svelte";
  import Episodes from "./lib/Episodes.svelte";
  import Logs from "./lib/Logs.svelte";
  import Toasts from "./lib/Toasts.svelte";

  onMount(() => {
    const poll = startPolling();
    const progressPoll = startProgressPolling();
    loadSettings();
    loadAuth();
    loadCoverage();
    loadMetadataAudit();
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
<a href="#pipeline" class="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:px-3 focus:py-1.5 focus:rounded focus:bg-primary focus:text-primary-content focus:text-sm">Skip to episodes</a>
<main class="p-4 sm:p-6 max-w-screen-2xl mx-auto flex flex-col gap-4">
  <AttentionBanner />
  <Episodes />
  <NewReleases />
  <System />
  <Controls />
  <Library />
  <Logs />
  <InfoCards />
</main>
<Settings />
<WhatsNew />
<Toasts />
