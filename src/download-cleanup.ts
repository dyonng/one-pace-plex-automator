import fs from "fs";
import path from "path";
import { DOWNLOAD_PATH } from "./constants";
import { logger } from "./logger";
import { getQbitClient } from "./qbittorrent";

// The downloads folder is shared with other downloaders, so the sweeper only
// ever touches entries that are recognizably ours. Everything else — other
// clients' folders, qBittorrent's own incomplete dir, the app's temp dir —
// is left strictly alone.
const OWNED_PREFIX = /^\[one pace/i;
const NEVER_TOUCH = new Set(["incomplete", "temp"]);

// Fresh entries are never orphans: a torrent added moments ago may not be
// visible in qBittorrent's listing yet, and an active download is always
// referenced anyway. This only backstops races, not policy.
const ORPHAN_MIN_AGE_MS = 60 * 60 * 1000;

export interface DownloadEntry {
  name: string;
  mtimeMs: number;
}

/** Top-level download entries whose content no live torrent references. Pure for testing. */
export function findOrphanDownloadEntries(
  entries: DownloadEntry[],
  activeContentPaths: Set<string>,
  downloadDir: string,
  now: number
): string[] {
  const orphans: string[] = [];
  for (const entry of entries) {
    if (!OWNED_PREFIX.test(entry.name)) continue;
    if (NEVER_TOUCH.has(entry.name.toLowerCase())) continue;
    if (now - entry.mtimeMs < ORPHAN_MIN_AGE_MS) continue;
    const full = path.join(downloadDir, entry.name);
    let active = false;
    for (const contentPath of activeContentPaths) {
      if (
        full === contentPath ||
        full.startsWith(contentPath + path.sep) ||
        contentPath.startsWith(full + path.sep)
      ) {
        active = true;
        break;
      }
    }
    if (!active) orphans.push(entry.name);
  }
  return orphans;
}

/**
 * Removes our own download leftovers no torrent claims anymore: multi-file
 * releases whose folders survived because the torrent entry was deleted
 * without its files. Never throws — cleanup must not fail a cycle.
 */
export async function cleanupOrphanDownloads(): Promise<number> {
  let activeContentPaths: Set<string>;
  try {
    const torrents = await getQbitClient().getTorrents();
    activeContentPaths = new Set(
      torrents.map((t) => t.content_path).filter((p): p is string => Boolean(p))
    );
  } catch (err) {
    logger.warn("Orphan download cleanup skipped — qBittorrent unreachable", {
      error: (err as Error).message,
    });
    return 0;
  }

  let entries: DownloadEntry[];
  try {
    entries = fs
      .readdirSync(DOWNLOAD_PATH, { withFileTypes: true })
      .map((e) => ({
        name: e.name,
        mtimeMs: fs.statSync(path.join(DOWNLOAD_PATH, e.name)).mtimeMs,
      }));
  } catch (err) {
    logger.warn("Orphan download cleanup skipped — downloads dir unreadable", {
      error: (err as Error).message,
    });
    return 0;
  }

  const orphans = findOrphanDownloadEntries(entries, activeContentPaths, DOWNLOAD_PATH, Date.now());
  for (const name of orphans) {
    try {
      fs.rmSync(path.join(DOWNLOAD_PATH, name), { recursive: true, force: true });
      logger.info("Removed orphaned download", { name });
    } catch (err) {
      logger.warn("Could not remove orphaned download", { name, error: (err as Error).message });
    }
  }
  return orphans.length;
}
