import fs from "fs";
import path from "path";
import { MEDIA_PATH } from "./constants";
import { logger } from "./logger";
import {
  resolveEpisodeByCrc32,
  extractCrc32FromFilename,
  extractResolutionFromFilename,
  buildPlexFilename,
} from "./metadata";
import { getEpisodeByCrc32, setEpisodeFinalFilename } from "./db";

const VIDEO_EXTS = new Set([".mkv", ".mp4", ".avi", ".m4v", ".mov"]);

export interface NamingCandidate {
  crc32: string;
  folder: string; // season folder the file lives in
  oldName: string;
  newName: string;
  arcPart: number;
  episodeNum: number;
  episodeTitle: string;
  extended: boolean;
}

/**
 * Walks the library and returns every video file whose name doesn't match our
 * canonical scheme. The correct name is derived from the file's CRC32 (which
 * uniquely identifies the release, including whether it's an extended cut);
 * resolution is taken from the existing name. Files without a resolvable CRC32
 * are skipped — we can't know the right name without knowing the release.
 */
export async function scanNamingCandidates(): Promise<NamingCandidate[]> {
  if (!fs.existsSync(MEDIA_PATH)) return [];

  const candidates: NamingCandidate[] = [];
  for (const dir of fs.readdirSync(MEDIA_PATH, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const seasonDir = path.join(MEDIA_PATH, dir.name);
    let files: fs.Dirent[];
    try {
      files = fs.readdirSync(seasonDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.isFile()) continue;
      const ext = path.extname(f.name);
      if (!VIDEO_EXTS.has(ext.toLowerCase())) continue;

      const crc32 = extractCrc32FromFilename(f.name);
      if (!crc32) continue;

      let meta;
      try {
        meta = await resolveEpisodeByCrc32(crc32);
      } catch {
        continue; // CRC32 not in the dataset — leave it alone
      }

      const resolution = extractResolutionFromFilename(f.name);
      const newName = buildPlexFilename(
        meta.arcTitle,
        meta.arcPart,
        meta.episodeNum,
        resolution,
        crc32,
        ext,
        meta.extended
      );

      if (newName !== f.name) {
        candidates.push({
          crc32,
          folder: dir.name,
          oldName: f.name,
          newName,
          arcPart: meta.arcPart,
          episodeNum: meta.episodeNum,
          episodeTitle: meta.episodeTitle,
          extended: meta.extended,
        });
      }
    }
  }

  candidates.sort((a, b) => a.arcPart - b.arcPart || a.episodeNum - b.episodeNum);
  return candidates;
}

export interface RenameResult {
  renamed: number;
  failed: number;
  details: string[];
}

/**
 * Renames the requested files (by CRC32) to their canonical names. Re-scans to
 * recompute the rename targets server-side rather than trusting client-supplied
 * paths. Keeps the episodes table's final_filename in sync when the file is
 * tracked. Returns the count renamed/failed.
 */
export async function applyNamingRenames(crc32s: string[]): Promise<RenameResult> {
  const wanted = new Set(crc32s.map((c) => c.toUpperCase()));
  const targets = (await scanNamingCandidates()).filter((c) => wanted.has(c.crc32.toUpperCase()));

  const result: RenameResult = { renamed: 0, failed: 0, details: [] };
  for (const c of targets) {
    const dir = path.join(MEDIA_PATH, c.folder);
    const from = path.join(dir, c.oldName);
    const to = path.join(dir, c.newName);
    try {
      if (fs.existsSync(to)) {
        result.failed++;
        result.details.push(`${c.newName} already exists`);
        continue;
      }
      fs.renameSync(from, to);
      // Keep tracking in sync if this exact file is recorded for the episode.
      const rec = getEpisodeByCrc32(c.crc32.toUpperCase());
      if (rec && rec.final_filename === c.oldName) {
        setEpisodeFinalFilename(c.crc32.toUpperCase(), c.newName);
      }
      result.renamed++;
      logger.info("Normalized file name", { from: c.oldName, to: c.newName });
    } catch (err) {
      result.failed++;
      result.details.push(`${c.oldName}: ${(err as Error).message}`);
    }
  }
  return result;
}
