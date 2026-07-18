import cron, { ScheduledTask } from "node-cron";
import { logger } from "./logger";
import { runAction, isBusy } from "./controls";
import { processDownloading } from "./processor";
import { backupDatabase, backupIfStale } from "./backup";
import { getSettingValue, getDownloadCheckMs, getPollEnabled, settingsBus } from "./settings";

const DEFAULT_CRON = "*/5 * * * *";
// Nightly DB backup — fixed (not dashboard-editable); 04:00 avoids poll traffic.
const BACKUP_CRON = "0 4 * * *";

let task: ScheduledTask | null = null;
let interval: NodeJS.Timeout | null = null;
let backupTask: ScheduledTask | null = null;

function scheduleCron(): void {
  task?.stop();
  task = null;

  if (!getPollEnabled()) {
    logger.info("Scheduled RSS polling disabled — manual only");
    return;
  }

  let expr = getSettingValue("POLL_CRON");
  if (!cron.validate(expr)) {
    logger.error("Invalid POLL_CRON, using default", { value: expr, fallback: DEFAULT_CRON });
    expr = DEFAULT_CRON;
  }
  task = cron.schedule(expr, async () => {
    try {
      // Route through the action lock so cron never overlaps a manual trigger.
      await runAction("refresh-sources");
    } catch (err) {
      logger.debug("Skipped scheduled poll", { reason: (err as Error).message });
    }
  });
  logger.info("Cron scheduled", { expr });
}

function scheduleInterval(): void {
  if (interval) clearInterval(interval);
  const ms = getDownloadCheckMs();
  interval = setInterval(async () => {
    if (isBusy()) return; // a heavier action is running; skip this tick
    try {
      await processDownloading();
    } catch (err) {
      logger.error("Unhandled error in download check", { error: (err as Error).message });
    }
  }, ms);
  logger.info("Download check interval set", { seconds: ms / 1000 });
}

export function startScheduler(): void {
  scheduleCron();
  scheduleInterval();

  backupTask = cron.schedule(BACKUP_CRON, async () => {
    try {
      await backupDatabase();
    } catch (err) {
      logger.warn("Scheduled database backup failed", { error: (err as Error).message });
    }
  });
  // Catch-up for servers that were off at the scheduled hour.
  void backupIfStale();

  // Live re-apply when the dashboard changes a schedule setting.
  settingsBus.on("changed", ({ key }: { key: string }) => {
    if (key === "POLL_CRON" || key === "POLL_ENABLED") scheduleCron();
    if (key === "DOWNLOAD_CHECK_SECONDS") scheduleInterval();
  });
}

export function stopScheduler(): void {
  task?.stop();
  task = null;
  backupTask?.stop();
  backupTask = null;
  if (interval) clearInterval(interval);
  interval = null;
}
