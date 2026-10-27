import path from "path";
import { logger } from "./logger";
import { getQbitClient, type TorrentFile } from "./qbittorrent";
import { newerFileAlreadyOnDisk } from "./processor";
import { findExistingEpisodeFile } from "./fileops";
import {
  extractCrc32FromFilename,
  parseReleaseFilename,
  parseResolutionFromFilename,
  resolveArcByTitle,
  resolveEpisodeByCrc32,
} from "./metadata";

/** Structural surface prepareBatchDownload needs — the real client satisfies it. */
export interface SelectionClient {
  addMagnet(source: string, opts?: { paused?: boolean }): Promise<string>;
  getTorrentFiles(hash: string): Promise<TorrentFile[]>;
  setFilePriorities(hash: string, ids: number[], priority: 0 | 1): Promise<void>;
  pauseTorrents(hashes: string[]): Promise<void>;
  resumeTorrents(hashes: string[]): Promise<void>;
}

const VIDEO_EXTS = new Set([".mkv", ".mp4", ".avi", ".m4v", ".mov"]);
const METADATA_POLL_MS = 5_000;

/**
 * Adds a torrent paused, deselects the files the library already satisfies, and
 * resumes. A batch routinely carries episodes we already hold (or hold newer
 * than) — downloading those again wastes bytes and wall time, so anything whose
 * slot the library already fills at equal-or-better quality gets priority 0.
 * Files that can't be placed (no CRC32, unknown title) download: an unwanted
 * file we skip is a failed episode, but an extra file is just disk.
 */
export async function prepareBatchDownload(
  source: string,
  opts: { client?: SelectionClient; metadataTimeoutMs?: number } = {}
): Promise<string> {
  const client = opts.client ?? getQbitClient();
  const hash = await client.addMagnet(source, { paused: true });
  if (!hash) return hash;
  try {
    const files = await waitForFiles(client, hash, opts.metadataTimeoutMs ?? 180_000);
    if (files.length === 0) {
      logger.warn("Torrent metadata never resolved — downloading everything", { hash });
      return hash;
    }
    if (files.length === 1) return hash;
    const skip = await classifyUnwanted(files);
    if (skip.length > 0) {
      await client.setFilePriorities(hash, skip, 0);
      logger.info("Skipped already-satisfied files in batch torrent", {
        hash,
        skipped: skip.length,
        of: files.length,
      });
    } else {
      logger.info("Batch torrent holds nothing already satisfied — downloading all", {
        hash,
        files: files.length,
      });
    }
  } catch (err) {
    logger.warn("Batch file selection failed — downloading everything", {
      hash,
      error: (err as Error).message,
    });
  } finally {
    try {
      await client.resumeTorrents([hash]);
    } catch (err) {
      logger.warn("Could not resume torrent after file selection — resume it manually", {
        hash,
        error: (err as Error).message,
      });
    }
  }
  return hash;
}

async function waitForFiles(
  client: SelectionClient,
  hash: string,
  timeoutMs: number
): Promise<TorrentFile[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const files = await client.getTorrentFiles(hash);
    if (files.length > 0) return files;
    if (Date.now() >= deadline) return [];
    await new Promise((r) => setTimeout(r, METADATA_POLL_MS));
  }
}

async function classifyUnwanted(files: TorrentFile[]): Promise<number[]> {
  const skip: number[] = [];
  for (const file of files) {
    const base = path.basename(file.name);
    if (!VIDEO_EXTS.has(path.extname(base).toLowerCase())) continue;
    if (await librarySatisfies(base)) skip.push(file.index);
  }
  return skip;
}

/** True when the library already holds this file's slot at equal-or-better quality. */
async function librarySatisfies(filename: string): Promise<boolean> {
  const crc32 = extractCrc32FromFilename(filename);
  if (!crc32) return false;
  const resolution = parseResolutionFromFilename(filename) ?? undefined;

  let arcTitle: string;
  let arcPart: number;
  let episodeNum: number;
  try {
    const meta = await resolveEpisodeByCrc32(crc32, resolution);
    arcTitle = meta.arcTitle;
    arcPart = meta.arcPart;
    episodeNum = meta.episodeNum;
  } catch {
    const parsed = parseReleaseFilename(filename);
    if (!parsed) return false;
    const arc = await resolveArcByTitle(parsed.arcTitle);
    if (!arc) return false;
    arcTitle = arc.arcTitle;
    arcPart = arc.arcPart;
    episodeNum = parsed.epNum;
  }

  const existing = findExistingEpisodeFile(arcTitle, arcPart, episodeNum);
  if (!existing) return false;
  if (existing.crc32 === crc32.toUpperCase()) return true;
  return (await newerFileAlreadyOnDisk(arcTitle, arcPart, episodeNum, crc32, resolution)) !== null;
}
