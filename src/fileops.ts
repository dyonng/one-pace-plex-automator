import fs from "fs";
import path from "path";
import { getConfig } from "./config";
import { logger } from "./logger";

export function buildSeasonFolder(arcTitle: string, arcPart: number): string {
  const season = String(arcPart).padStart(2, "0");
  return `Season ${season} - ${arcTitle}`;
}

export function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
    logger.info("Created directory", { path: dirPath });
  }
}

export function moveAndRename(sourcePath: string, finalFilename: string, arcTitle: string, arcPart: number): string {
  const { MEDIA_PATH, SERIES_FOLDER_NAME } = getConfig();
  const seasonFolder = buildSeasonFolder(arcTitle, arcPart);
  const destDir = path.join(MEDIA_PATH, SERIES_FOLDER_NAME, seasonFolder);
  ensureDir(destDir);

  const destPath = path.join(destDir, finalFilename);

  if (fs.existsSync(destPath)) {
    logger.warn("Destination file already exists, overwriting", { destPath });
  }

  fs.renameSync(sourcePath, destPath);
  logger.info("Moved file to Plex library", { from: sourcePath, to: destPath });
  return destPath;
}

export function findDownloadedFile(downloadDir: string, crc32: string): string | null {
  if (!fs.existsSync(downloadDir)) return null;

  const entries = fs.readdirSync(downloadDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    // Match by CRC32 in brackets at end of filename
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
