import fs from "fs";
import path from "path";
import { MEDIA_PATH } from "./constants";
import { logger } from "./logger";

let _zeroPadSeasons = false;
const _seasonFolderCache = new Map<number, string>();

export function detectSeasonFormat(): void {
  if (!fs.existsSync(MEDIA_PATH)) {
    logger.warn("Media path not found, defaulting to unpadded season folders", { path: MEDIA_PATH });
    return;
  }

  const entries = fs.readdirSync(MEDIA_PATH, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = entry.name.match(/^Season (\d+) - /);
    if (!match) continue;
    const arcPart = parseInt(match[1], 10);
    _seasonFolderCache.set(arcPart, entry.name);
    if (!_zeroPadSeasons && match[1].length > 1 && match[1].startsWith("0")) {
      _zeroPadSeasons = true;
    }
  }

  logger.info("Season folder cache built", {
    count: _seasonFolderCache.size,
    zeroPadded: _zeroPadSeasons,
  });
}

export function buildSeasonFolder(arcTitle: string, arcPart: number): string {
  const cached = _seasonFolderCache.get(arcPart);
  if (cached) return cached;
  const num = _zeroPadSeasons ? String(arcPart).padStart(2, "0") : String(arcPart);
  return `Season ${num} - ${arcTitle}`;
}

export function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
    logger.info("Created directory", { path: dirPath });
  }
}

/**
 * Removes any existing files in a season folder that match the same season+episode
 * but are a different file. Catches One Pace re-releases (new CRC32, possibly new
 * resolution) and any pre-existing library files the service never downloaded itself.
 * Returns the names of the files that were removed.
 */
export function removeExistingEpisodeFiles(
  destDir: string,
  arcPart: number,
  episodeNum: number,
  keepFilename: string
): string[] {
  if (!fs.existsSync(destDir)) return [];

  // Match S##E## with optional zero-padding, guarding against S1E1 matching S1E12.
  const sePattern = new RegExp(`S0*${arcPart}(?!\\d)E0*${episodeNum}(?!\\d)`, "i");
  const removed: string[] = [];

  for (const entry of fs.readdirSync(destDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (entry.name === keepFilename) continue;
    if (!sePattern.test(entry.name)) continue;

    fs.rmSync(path.join(destDir, entry.name));
    removed.push(entry.name);
    logger.info("Removed superseded episode file", { file: entry.name, arcPart, episodeNum });
  }

  return removed;
}

export interface MoveResult {
  destPath: string;
  replaced: string[];
}

/**
 * Moves a file, handling the case where source and destination are on different
 * filesystems (qBittorrent's download volume vs the Plex media volume), where a
 * plain rename throws EXDEV. Falls back to copy-to-temp + atomic rename + unlink
 * so the destination never sees a partially written file.
 */
function moveFile(src: string, dest: string): void {
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
    fs.copyFileSync(src, tmp);
    try {
      fs.renameSync(tmp, dest); // same filesystem now — atomic
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw e;
    }
    fs.rmSync(src, { force: true });
  }
}

export function moveAndRename(
  sourcePath: string,
  finalFilename: string,
  arcTitle: string,
  arcPart: number,
  episodeNum: number
): MoveResult {
  const seasonFolder = buildSeasonFolder(arcTitle, arcPart);
  const destDir = path.join(MEDIA_PATH, seasonFolder);
  ensureDir(destDir);

  const destPath = path.join(destDir, finalFilename);
  if (fs.existsSync(destPath)) {
    logger.warn("Destination file already exists, overwriting", { destPath });
  }

  // Move the new file into place FIRST, then remove any superseded copies — so a
  // failed move never leaves the episode missing from the library.
  moveFile(sourcePath, destPath);
  const replaced = removeExistingEpisodeFiles(destDir, arcPart, episodeNum, finalFilename);

  logger.info("Moved file to Plex library", { from: sourcePath, to: destPath, replaced: replaced.length });
  return { destPath, replaced };
}

/** Deletes a moved episode file from the Plex library, if it exists. */
export function deleteEpisodeFile(arcTitle: string, arcPart: number, finalFilename: string): boolean {
  const full = path.join(MEDIA_PATH, buildSeasonFolder(arcTitle, arcPart), finalFilename);
  _fileSizeCache.delete(full);
  if (fs.existsSync(full)) {
    fs.rmSync(full, { force: true });
    logger.info("Deleted episode file", { path: full });
    return true;
  }
  return false;
}

// Moved library files are immutable once placed, so cache their sizes to avoid
// a statSync on every status poll.
const _fileSizeCache = new Map<string, number>();

/** Returns the on-disk size in bytes of a moved episode file, or null if absent. */
export function getEpisodeFileSize(arcTitle: string, arcPart: number, finalFilename: string | null): number | null {
  if (!finalFilename) return null;
  const full = path.join(MEDIA_PATH, buildSeasonFolder(arcTitle, arcPart), finalFilename);
  const cached = _fileSizeCache.get(full);
  if (cached !== undefined) return cached;
  try {
    const size = fs.statSync(full).size;
    _fileSizeCache.set(full, size);
    return size;
  } catch {
    return null;
  }
}

export interface BatchFile {
  filePath: string;
  filename: string;
  crc32: string;
}

const BATCH_VIDEO_EXTS = new Set([".mkv", ".mp4", ".avi", ".m4v", ".mov"]);

/**
 * Returns all video files in `dir` whose filename contains a bracketed 8-hex
 * CRC32. Used by the processor to pick up sibling episodes from a batch torrent.
 */
/**
 * Every CRC32-tagged video under `dir`, at any depth — a batch torrent may put
 * episodes straight in the folder or inside per-season subfolders.
 */
export function scanBatchFiles(dir: string): BatchFile[] {
  if (!fs.existsSync(dir)) return [];
  const results: BatchFile[] = [];
  walkFiles(dir, 0, (dirPath, name) => {
    if (!BATCH_VIDEO_EXTS.has(path.extname(name).toLowerCase())) return false;
    const m = name.match(/\[([0-9A-Fa-f]{8})\]/);
    if (m) {
      results.push({ filePath: path.join(dirPath, name), filename: name, crc32: m[1].toUpperCase() });
    }
    return false; // keep walking — we want them all
  });
  return results;
}

// qBittorrent's layout under the download dir varies: a loose file, a folder per
// torrent, a category folder, or a combination. Walk the tree instead of assuming
// a depth — bounded so a deep or looping mount can't spin.
const MAX_SCAN_DEPTH = 5;

function walkFiles(dir: string, depth: number, visit: (dirPath: string, name: string) => boolean): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false; // unreadable (permissions, vanished mid-scan) — skip, don't throw
  }
  for (const entry of entries) {
    if (entry.isFile() && visit(dir, entry.name)) return true;
  }
  if (depth >= MAX_SCAN_DEPTH) return false;
  for (const entry of entries) {
    // isDirectory() is false for symlinks, so loops can't be followed.
    if (entry.isDirectory() && walkFiles(path.join(dir, entry.name), depth + 1, visit)) return true;
  }
  return false;
}

/**
 * Locates a completed download by the CRC32 in its filename, at any depth under
 * `downloadDir`. Depth matters: a whole-arc batch lands as
 * `<downloads>/<category>/<arc folder>/<episode>.mkv`, which a shallow search
 * misses entirely ("Downloaded file not found in /downloads for CRC32 …").
 */
export function findDownloadedFile(downloadDir: string, crc32: string): string | null {
  if (!fs.existsSync(downloadDir)) return null;
  const needle = `[${crc32.toUpperCase()}]`;
  let found: string | null = null;
  walkFiles(downloadDir, 0, (dirPath, name) => {
    if (!name.toUpperCase().includes(needle)) return false;
    found = path.join(dirPath, name);
    return true;
  });
  return found;
}
