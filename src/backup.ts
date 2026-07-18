import fs from "fs";
import path from "path";
import { DATA_DIR } from "./constants";
import { getDb } from "./db";
import { logger } from "./logger";

// Nightly safety copies of the SQLite state (settings, auth hash, pipeline and
// reconcile state). Uses better-sqlite3's online backup API, which is safe to
// run against a live WAL database.
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const KEEP = 7;
const STALE_MS = 24 * 60 * 60 * 1000;

const stamp = (d: Date): string =>
  d.toISOString().replace(/[:T]/g, "-").replace(/\..+$/, "");

function listBackups(): string[] {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => /^state-.*\.db$/.test(f))
    .sort(); // timestamp-named → lexicographic == chronological
}

/** Creates a backup and prunes old ones down to the newest KEEP. */
export async function backupDatabase(): Promise<string> {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const dest = path.join(BACKUP_DIR, `state-${stamp(new Date())}.db`);
  await getDb().backup(dest);

  const backups = listBackups();
  for (const old of backups.slice(0, Math.max(0, backups.length - KEEP))) {
    try {
      fs.unlinkSync(path.join(BACKUP_DIR, old));
    } catch {}
  }
  logger.info("Database backed up", { file: path.basename(dest), kept: Math.min(backups.length, KEEP) });
  return dest;
}

/** Newest backup's mtime, or null when none exist. */
function newestBackupAt(): number | null {
  const backups = listBackups();
  if (backups.length === 0) return null;
  try {
    return fs.statSync(path.join(BACKUP_DIR, backups[backups.length - 1])).mtimeMs;
  } catch {
    return null;
  }
}

/** Boot-time catch-up: back up now if there's no backup from the last 24h
 *  (covers servers that are off at the scheduled hour). Never throws. */
export async function backupIfStale(): Promise<void> {
  const newest = newestBackupAt();
  if (newest !== null && Date.now() - newest < STALE_MS) return;
  try {
    await backupDatabase();
  } catch (err) {
    logger.warn("Startup database backup failed", { error: (err as Error).message });
  }
}
