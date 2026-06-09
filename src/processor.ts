import fs from "fs";
import path from "path";
import { getConfig } from "./config";
import { DOWNLOAD_PATH, MEDIA_PATH } from "./constants";
import { logger } from "./logger";
import { getEpisodeByCrc32, getEpisodesByStatus, updateEpisodeStatus, upsertEpisode } from "./db";
import { getQbitClient } from "./qbittorrent";
import { resolveEpisodeByCrc32, buildPlexFilename, extractResolutionFromFilename, getAllArcs, getAllEpisodes, type ResolvedEpisode } from "./metadata";
import { buildSeasonFolder, findDownloadedFile, moveAndRename, scanBatchFiles } from "./fileops";
import { triggerLibraryScan, syncSingleEpisode, syncFullLibrary } from "./plex";
import { sendDiscordNotification } from "./discord";
import { ensureSeasonPoster } from "./posters";
import { getAutoPosters } from "./settings";
import { scanCoverage, getStoredCoverage } from "./coverage";

interface BatchResult {
  crc32: string;
  meta: ResolvedEpisode;
  finalFilename: string;
  replaced: string[];
}

/**
 * After the primary episode file has been moved, scan the same torrent subfolder
 * for sibling files. Each file whose CRC32 matches the dataset is moved to the
 * Plex library and marked done. Unresolvable files are skipped with a warning.
 */
async function processBatchSiblings(
  batchDir: string,
  torrentHash: string,
  primaryCrc32: string
): Promise<BatchResult[]> {
  const results: BatchResult[] = [];
  for (const sibling of scanBatchFiles(batchDir)) {
    if (sibling.crc32 === primaryCrc32.toUpperCase()) continue;
    const existing = getEpisodeByCrc32(sibling.crc32);
    if (existing?.status === "done") continue;
    if (existing?.status === "downloading" || existing?.status === "processing") continue;
    try {
      const resolution = extractResolutionFromFilename(sibling.filename);
      const meta = await resolveEpisodeByCrc32(sibling.crc32, resolution);
      const ext = path.extname(sibling.filePath);
      const finalFilename = buildPlexFilename(
        meta.arcTitle, meta.arcPart, meta.episodeNum, meta.resolution, sibling.crc32, ext
      );

      // If the file is already on disk at the correct path, just record it in the DB
      // rather than copying it over itself (avoids redundant I/O for already-imported episodes).
      const destPath = path.join(MEDIA_PATH, buildSeasonFolder(meta.arcTitle, meta.arcPart), finalFilename);
      if (fs.existsSync(destPath)) {
        if (!existing) {
          upsertEpisode({
            crc32: sibling.crc32,
            arc_num: meta.arcIndex,
            arc_title: meta.arcTitle,
            arc_part: meta.arcPart,
            episode_num: meta.episodeNum,
            resolution: meta.resolution,
            original_filename: sibling.filename,
            final_filename: finalFilename,
            status: "done",
            torrent_hash: torrentHash,
            magnet_uri: null,
            error_message: null,
            rss_guid: "",
            changelog: [],
          });
        } else {
          updateEpisodeStatus(sibling.crc32, "done", { final_filename: finalFilename });
        }
        logger.debug("Batch sibling already on disk, recorded in DB", { crc32: sibling.crc32, filename: finalFilename });
        continue;
      }

      const { replaced } = moveAndRename(
        sibling.filePath, finalFilename, meta.arcTitle, meta.arcPart, meta.episodeNum
      );
      if (!existing) {
        upsertEpisode({
          crc32: sibling.crc32,
          arc_num: meta.arcIndex,
          arc_title: meta.arcTitle,
          arc_part: meta.arcPart,
          episode_num: meta.episodeNum,
          resolution: meta.resolution,
          original_filename: sibling.filename,
          final_filename: finalFilename,
          status: "done",
          torrent_hash: torrentHash,
          magnet_uri: null,
          error_message: null,
          rss_guid: "",
          changelog: [],
        });
      } else {
        updateEpisodeStatus(sibling.crc32, "done", { final_filename: finalFilename });
      }
      results.push({ crc32: sibling.crc32, meta, finalFilename, replaced });
      logger.info("Processed batch sibling", { crc32: sibling.crc32, filename: finalFilename });
    } catch (err) {
      logger.warn("Skipping unresolvable batch file", {
        crc32: sibling.crc32,
        file: sibling.filename,
        error: (err as Error).message,
      });
    }
  }
  return results;
}

let _processing = false;

export async function processDownloading(): Promise<void> {
  // The 30s interval and the cron cycle can both call this; never run two at once
  // (would double-process the same episode if one run exceeds the interval).
  if (_processing) return;
  _processing = true;
  try {
    await _processDownloading();
  } finally {
    _processing = false;
  }
}

async function _processDownloading(): Promise<void> {
  const downloading = getEpisodesByStatus("downloading");
  if (downloading.length === 0) return;

  const qbit = getQbitClient();
  let completed = 0;

  for (const ep of downloading) {
    if (!ep.torrent_hash) continue;

    try {
      const done = await qbit.isComplete(ep.torrent_hash);
      if (!done) {
        logger.debug("Still downloading", { crc32: ep.crc32, hash: ep.torrent_hash });
        continue;
      }

      logger.info("Download complete, processing", { crc32: ep.crc32 });
      updateEpisodeStatus(ep.crc32, "processing");

      const sourcePath = findDownloadedFile(DOWNLOAD_PATH, ep.crc32);
      if (!sourcePath) {
        throw new Error(`Downloaded file not found in ${DOWNLOAD_PATH} for CRC32 ${ep.crc32}`);
      }

      const epMeta = await resolveEpisodeByCrc32(ep.crc32, ep.resolution);

      const ext = path.extname(sourcePath);
      const finalFilename = buildPlexFilename(
        epMeta.arcTitle, // resolved title honors the Arabasta/Alabasta preference
        ep.arc_part,
        ep.episode_num,
        ep.resolution,
        ep.crc32,
        ext,
        epMeta.extended
      );

      const { replaced } = moveAndRename(
        sourcePath,
        finalFilename,
        ep.arc_title,
        ep.arc_part,
        ep.episode_num
      );

      // If the source was in a torrent subfolder (i.e. a batch release), process
      // any sibling episodes before triggering the Plex scan — one scan covers all.
      const sourceDir = path.dirname(sourcePath);
      const siblings = sourceDir !== DOWNLOAD_PATH
        ? await processBatchSiblings(sourceDir, ep.torrent_hash, ep.crc32)
        : [];

      // Mark done now — the file is safely on disk. Plex scan/sync is best-effort;
      // a transient Plex error must not flip a successfully-moved episode to "failed".
      updateEpisodeStatus(ep.crc32, "done", { final_filename: finalFilename });
      completed++;

      try {
        await triggerLibraryScan();
        await new Promise((resolve) => setTimeout(resolve, 5000));
        await syncSingleEpisode({
          ...epMeta,
          seasonEpisodeId: `s${String(ep.arc_part).padStart(2, "0")}e${String(ep.episode_num).padStart(2, "0")}`,
        });
        for (const s of siblings) {
          try {
            await syncSingleEpisode({
              ...s.meta,
              seasonEpisodeId: `s${String(s.meta.arcPart).padStart(2, "0")}e${String(s.meta.episodeNum).padStart(2, "0")}`,
            });
          } catch (err) {
            logger.warn("Plex sync failed for batch sibling", { crc32: s.crc32, error: (err as Error).message });
          }
        }
      } catch (err) {
        logger.warn("Plex scan/sync failed after ingest — file is on disk, use Full Sync to recover", {
          crc32: ep.crc32, error: (err as Error).message,
        });
      }

      // Auto-apply season posters for all arc parts encountered (primary + siblings).
      if (getAutoPosters()) {
        const arcParts = new Set([ep.arc_part, ...siblings.map((s) => s.meta.arcPart)]);
        for (const arcPart of arcParts) await ensureSeasonPoster(arcPart);
      }

      await sendDiscordNotification({
        type: replaced.length > 0 ? "episode_updated" : "download_complete",
        crc32: ep.crc32,
        arcTitle: ep.arc_title,
        arcPart: ep.arc_part,
        episodeNum: ep.episode_num,
        episodeTitle: epMeta.episodeTitle,
        filename: finalFilename,
        replacedFilenames: replaced,
        changelog: ep.changelog,
      });
      for (const s of siblings) {
        await sendDiscordNotification({
          type: s.replaced.length > 0 ? "episode_updated" : "download_complete",
          crc32: s.crc32,
          arcTitle: s.meta.arcTitle,
          arcPart: s.meta.arcPart,
          episodeNum: s.meta.episodeNum,
          episodeTitle: s.meta.episodeTitle,
          filename: s.finalFilename,
          replacedFilenames: s.replaced,
          changelog: [],
        });
      }

      // Remove torrent from qBit (keep file)
      await qbit.deleteTorrent(ep.torrent_hash, false);
    } catch (err) {
      const msg = (err as Error).message;
      logger.error("Failed to process completed download", { crc32: ep.crc32, error: msg });
      updateEpisodeStatus(ep.crc32, "failed", { error_message: msg });
      await sendDiscordNotification({
        type: "error",
        crc32: ep.crc32,
        error: msg,
      });
    }
  }

  // Refresh the stored coverage report so the dashboard reflects newly-ingested
  // episodes without a manual re-scan. Only when something finished and a scan
  // has been run before — no work on idle cycles.
  if (completed > 0 && getStoredCoverage()) {
    try {
      await scanCoverage();
      logger.info("Coverage report refreshed after ingest", { completed });
    } catch (err) {
      logger.warn("Coverage refresh after ingest failed", { error: (err as Error).message });
    }
  }
}

export async function runMetadataSync(): Promise<void> {
  logger.info("Starting full Plex metadata sync");
  try {
    const [arcs, episodes] = await Promise.all([getAllArcs(), getAllEpisodes()]);
    await syncFullLibrary(arcs, episodes);
  } catch (err) {
    logger.error("Full metadata sync failed", { error: (err as Error).message });
  }
}

export async function retryFailed(): Promise<void> {
  const failed = getEpisodesByStatus("failed");
  for (const ep of failed) {
    logger.info("Retrying failed episode", { crc32: ep.crc32 });
    updateEpisodeStatus(ep.crc32, "pending", { error_message: null });
  }
}
