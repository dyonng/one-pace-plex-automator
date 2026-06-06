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

export function findDownloadedFile(downloadDir: string, crc32: string): string | null {
  if (!fs.existsSync(downloadDir)) return null;

  const entries = fs.readdirSync(downloadDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (name.toUpperCase().includes(`[${crc32.toUpperCase()}]`)) {
      return path.join(downloadDir, name);
    }
  }

  // Also check one level deep (torrent may create a subfolder)
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const subDir = path.join(downloadDir, entry.name);
    const subEntries = fs.readdirSync(subDir, { withFileTypes: true });
    for (const sub of subEntries) {
      if (sub.isFile() && sub.name.toUpperCase().includes(`[${crc32.toUpperCase()}]`)) {
        return path.join(subDir, sub.name);
      }
    }
  }

  return null;
}
