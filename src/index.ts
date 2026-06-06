import cron from "node-cron";
import { getConfig } from "./config";
import { logger } from "./logger";
import { runCycle } from "./cycle";
import { processDownloading } from "./processor";
import { runAction, isBusy } from "./controls";
import { boot } from "./boot";
import { startDashboard } from "./web/server";
import { closeDb } from "./db";

const DEFAULT_CRON = "*/5 * * * *";

async function bootstrap(): Promise<void> {
  await boot();
  const dashboard = startDashboard();

  let { POLL_CRON } = getConfig();
  if (!cron.validate(POLL_CRON)) {
    logger.error("Invalid POLL_CRON, falling back to default", { value: POLL_CRON, fallback: DEFAULT_CRON });
    POLL_CRON = DEFAULT_CRON;
  }

  await runCycle();

  cron.schedule(POLL_CRON, async () => {
    try {
      // Route through the action lock so cron never overlaps a manual trigger.
      await runAction("poll");
    } catch (err) {
      logger.debug("Skipped scheduled poll", { reason: (err as Error).message });
    }
  });

  const interval = setInterval(async () => {
    if (isBusy()) return; // a heavier action is running; skip this tick
    try {
      await processDownloading();
    } catch (err) {
      logger.error("Unhandled error in download check", { error: (err as Error).message });
    }
  }, 30_000);

  // Graceful shutdown — close the dashboard + DB cleanly on container stop.
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("Shutting down", { signal });
    clearInterval(interval);
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
