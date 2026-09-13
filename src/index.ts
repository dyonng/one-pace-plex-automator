import { logger } from "./logger";
import { runCycle } from "./cycle";
import { boot } from "./boot";
import { startDashboard } from "./web/server";
import { startScheduler, stopScheduler } from "./scheduler";
import { startHealthMonitor, stopHealthMonitor } from "./health";
import { abortAllTransfers } from "./pixeldrain-downloads";
import { closeDb } from "./db";

async function bootstrap(): Promise<void> {
  await boot();
  const dashboard = startDashboard();

  await runCycle();
  startScheduler();
  startHealthMonitor();

  // Graceful shutdown — stop timers, close the dashboard + DB on container stop.
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("Shutting down", { signal });
    stopScheduler();
    stopHealthMonitor();
    // Cancel in-flight HTTP downloads so they stop cleanly; the .part files stay
    // on disk and the next run resumes from where each left off.
    abortAllTransfers();
    try { dashboard?.close(); } catch { /* ignore */ }
    try { closeDb(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

// Keep the 24/7 process alive through stray async errors instead of dying.
process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection", { error: String(reason) });
});
process.on("uncaughtException", (err) => {
  // Unknown state after an uncaught throw — log and exit so Docker's restart
  // policy gives us a clean process.
  logger.error("Uncaught exception, exiting for restart", { error: (err as Error).message });
  process.exit(1);
});

bootstrap().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
