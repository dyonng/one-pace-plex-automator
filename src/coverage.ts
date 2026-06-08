import fs from "fs";
import path from "path";
import { MEDIA_PATH } from "./constants";
import { logger } from "./logger";
import { getKv, setKv, getEpisodeByCrc32, getEpisodesByStatus } from "./db";
import { getAllEpisodes, extractCrc32FromFilename } from "./metadata";
import { getRssMagnetMap } from "./rss";

// Latest report only — a single upserted kv row, so it never grows and survives
// restarts. The dashboard reads this; a scan overwrites it.
const KV_KEY = "coverage_report";
// Lightweight companion to KV_KEY so the status endpoint can report freshness
// without parsing the full report on every poll.
const KV_SCANNED_AT = "coverage_scanned_at";

const VIDEO_EXTS = new Set([".mkv", ".mp4", ".avi", ".m4v", ".mov"]);

export type CoverageStatus =
  | "present"         // on disk, CRC32 matches the dataset's current release
  | "present_unknown" // on disk, but filename has no CRC32 so we can't verify
  | "upgradeable"     // on disk with old CRC32 — a newer version exists
  | "downloading"     // the canonical release is in the pipeline right now
  | "missing";        // not on disk

export interface CoverageEpisode {
  arcPart: number;
  episodeNum: number;
  seasonEpisodeId: string;
  episodeTitle: string;
  datasetCrc32: string;
  status: CoverageStatus;
  diskFilename: string | null;
  diskCrc32: string | null;
  hasMagnet: boolean; // true when a magnet for the latest CRC32 is stored in the DB
  extended: boolean;  // true when the canonical release is the extended cut
}

export interface CoverageArc {
  arcPart: number;
  arcTitle: string;
  arcSaga: string;
  total: number;
  present: number;
  missing: number;
  upgradeable: number;
  downloading: number;
  seasonFolder: string | null; // actual on-disk folder name, if any files were found
  episodes: CoverageEpisode[];
}

export interface CoverageReport {
  scannedAt: number;
  mediaPath: string;
  mediaPathExists: boolean;
  totals: { episodes: number; present: number; missing: number; upgradeable: number; downloading: number };
  arcs: CoverageArc[];
  extras: string[]; // video files on disk that map to no dataset episode
}

interface DiskFile {
  filename: string;
  crc32: string | null;
  folder: string; // the season folder the file was found in
}

const seKey = (season: number, episode: number): string => `${season}-${episode}`;

/**
 * Walks the season folders under MEDIA_PATH and indexes every video file by the
 * S##E## parsed from its name. Keyed off the filename (not the folder) so it's
 * robust to whatever season-folder naming the user has.
 */
function scanDisk(): Map<string, DiskFile> {
  const byEpisode = new Map<string, DiskFile>();
  if (!fs.existsSync(MEDIA_PATH)) return byEpisode;

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
      if (!VIDEO_EXTS.has(path.extname(f.name).toLowerCase())) continue;
      const m = f.name.match(/S(\d+)E(\d+)/i);
      if (!m) continue;
      const season = parseInt(m[1], 10);
      const episode = parseInt(m[2], 10);
      byEpisode.set(seKey(season, episode), {
        filename: f.name,
        crc32: extractCrc32FromFilename(f.name),
        folder: dir.name,
      });
    }
  }

  return byEpisode;
}

/**
 * Diffs the on-disk library against the One Pace dataset to report what's
 * present, missing, and upgradeable (on disk but with an out-of-date CRC32).
 */
export async function scanCoverage(): Promise<CoverageReport> {
  const mediaPathExists = fs.existsSync(MEDIA_PATH);
  const disk = scanDisk();
  const [dataset, rssMagnets] = await Promise.all([getAllEpisodes(), getRssMagnetMap()]);

  // CRC32s currently moving through the pipeline — an episode being downloaded
  // (e.g. an upgrade in progress) should show as "downloading", not offered
  // again as missing or upgradeable.
  const inFlight = new Set<string>();
  for (const st of ["pending", "downloading", "processing"] as const) {
    for (const e of getEpisodesByStatus(st)) inFlight.add(e.crc32.toUpperCase());
  }

  const arcMap = new Map<number, CoverageArc>();

  for (const ep of dataset) {
    const key = seKey(ep.arcPart, ep.episodeNum);
    const onDisk = disk.get(key);
    disk.delete(key); // whatever's left over becomes "extras"

    let status: CoverageStatus;
    let hasMagnet = false;
    if (!onDisk) status = "missing";
    else if (!onDisk.crc32) status = "present_unknown";
    else if (onDisk.crc32.toUpperCase() === ep.crc32.toUpperCase()) status = "present";
    else {
      status = "upgradeable";
      const rssEntry = rssMagnets.get(ep.crc32.toUpperCase());
      hasMagnet = Boolean(getEpisodeByCrc32(ep.crc32.toUpperCase())?.magnet_uri) || Boolean(rssEntry);
      // Store the magnet in KV so the upgrade action can use it without a live
      // RSS lookup, even across restarts.
      if (rssEntry) {
        setKv(`magnet:${ep.crc32.toUpperCase()}`, JSON.stringify(rssEntry));
      }
    }

    // The canonical release is already in the pipeline — surface that instead of
    // missing/upgradeable so it isn't offered as a (re)download.
    if ((status === "missing" || status === "upgradeable") && inFlight.has(ep.crc32.toUpperCase())) {
      status = "downloading";
    }

    let arc = arcMap.get(ep.arcPart);
    if (!arc) {
      arc = {
        arcPart: ep.arcPart,
        arcTitle: ep.arcTitle,
        arcSaga: ep.arcSaga,
        total: 0,
        present: 0,
        missing: 0,
        upgradeable: 0,
        downloading: 0,
        seasonFolder: null,
        episodes: [],
      };
      arcMap.set(ep.arcPart, arc);
    }

    if (onDisk && !arc.seasonFolder) arc.seasonFolder = onDisk.folder;

    arc.total++;
    if (status === "missing") arc.missing++;
    else if (status === "upgradeable") arc.upgradeable++;
    else if (status === "downloading") arc.downloading++;
    else arc.present++; // present + present_unknown

    arc.episodes.push({
      arcPart: ep.arcPart,
      episodeNum: ep.episodeNum,
      seasonEpisodeId: ep.seasonEpisodeId,
      episodeTitle: ep.episodeTitle,
      datasetCrc32: ep.crc32.toUpperCase(),
      status,
      diskFilename: onDisk?.filename ?? null,
      diskCrc32: onDisk?.crc32 ?? null,
      hasMagnet,
      extended: ep.extended,
    });
  }

  const arcs = [...arcMap.values()].sort((a, b) => a.arcPart - b.arcPart);
  for (const arc of arcs) arc.episodes.sort((a, b) => a.episodeNum - b.episodeNum);

  const totals = arcs.reduce(
    (t, a) => ({
      episodes: t.episodes + a.total,
      present: t.present + a.present,
      missing: t.missing + a.missing,
      upgradeable: t.upgradeable + a.upgradeable,
      downloading: t.downloading + a.downloading,
    }),
    { episodes: 0, present: 0, missing: 0, upgradeable: 0, downloading: 0 }
  );

  const extras = [...disk.values()].map((f) => f.filename).sort();

  logger.info("Coverage scan complete", {
    present: totals.present,
    missing: totals.missing,
    upgradeable: totals.upgradeable,
    extras: extras.length,
  });

  const report: CoverageReport = {
    scannedAt: Date.now(),
    mediaPath: MEDIA_PATH,
    mediaPathExists,
    totals,
    arcs,
    extras,
  };

  setKv(KV_KEY, JSON.stringify(report));
  setKv(KV_SCANNED_AT, String(report.scannedAt));
  return report;
}

/** Timestamp of the last stored scan, or null if none has run. Cheap to read. */
export function getCoverageScannedAt(): number | null {
  const raw = getKv(KV_SCANNED_AT);
  return raw ? Number(raw) : null;
}

/**
 * Re-scan and store coverage, but only if a report already exists — so pipeline
 * changes (downloads, upgrades, removals) reflect in the dashboard without a
 * manual re-scan, and nothing runs for users who've never scanned. Never throws.
 */
export async function refreshCoverageIfPresent(): Promise<void> {
  if (getCoverageScannedAt() === null) return;
  try {
    await scanCoverage();
  } catch (err) {
    logger.warn("Coverage refresh failed", { error: (err as Error).message });
  }
}

/** Returns the last scan from the kv store, or null if no scan has run yet. */
export function getStoredCoverage(): CoverageReport | null {
  const raw = getKv(KV_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CoverageReport;
  } catch {
    return null;
  }
}
