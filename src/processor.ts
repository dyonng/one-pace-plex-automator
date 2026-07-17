import fs from "fs";
import path from "path";
import { getConfig } from "./config";
import { DOWNLOAD_PATH, MEDIA_PATH } from "./constants";
import { logger } from "./logger";
import { getEpisodeByCrc32, getEpisodesByStatus, updateEpisodeStatus, upsertEpisode, deleteEpisode, type EpisodeRecord } from "./db";
import { getQbitClient, type TorrentInfo } from "./qbittorrent";
import { resolveEpisodeByCrc32, buildPlexFilename, extractResolutionFromFilename, parseResolutionFromFilename, extractCrc32FromFilename, isProvisionalKey, getAllArcs, getAllEpisodes, type ResolvedEpisode } from "./metadata";
import { getArcResolution } from "./onepace-sheet";
import { buildSeasonFolder, findDownloadedFile, moveAndRename, scanBatchFiles, type BatchFile } from "./fileops";
import { triggerLibraryScan, syncSingleEpisode, syncFullLibrary } from "./plex";
import { sendDiscordNotification } from "./discord";
import { ensureSeasonPoster } from "./posters";
import { getAutoPosters, getAutoReconcile } from "./settings";
import { scanCoverage, getStoredCoverage } from "./coverage";
import { reconcilePlexMetadata } from "./metadata-audit";
import { lookupEpisodeText, lookupArcText } from "./onepace-descriptions";

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
            extended: meta.extended,
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
          extended: meta.extended,
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

/**
 * Locates the downloaded video file(s) for a torrent we don't have a CRC32 for
 * (a provisional download). qBittorrent's content_path is in its own namespace,
 * so we remap it onto our DOWNLOAD_PATH mount via the basename and scan there.
 */
function locateTorrentVideos(torrent: TorrentInfo): BatchFile[] {
  const base = path.basename(torrent.content_path || torrent.name || "");
  if (!base) return [];
  const local = path.join(DOWNLOAD_PATH, base);
  if (!fs.existsSync(local)) return [];
  const stat = fs.statSync(local);
  if (stat.isFile()) {
    const crc32 = extractCrc32FromFilename(base);
    return crc32 ? [{ filePath: local, filename: base, crc32 }] : [];
  }
  return scanBatchFiles(local);
}

/**
 * Processes a completed provisional download: finds the real video file, recovers
 * its CRC32 + resolution, resolves metadata (falling back to the arc/episode
 * parsed at queue time when the catalog still lacks it), moves the file, and
 * re-keys the DB record from its synthetic PROV key to the real CRC32.
 * Returns true if a file was successfully imported.
 */
async function processProvisionalDownload(ep: EpisodeRecord, torrentHash: string): Promise<boolean> {
  const torrent = await getQbitClient().getTorrent(torrentHash);
  if (!torrent) throw new Error(`Torrent ${torrentHash} not found in qBittorrent`);

  const videos = locateTorrentVideos(torrent);
  if (videos.length === 0) {
    throw new Error(`No CRC32-tagged video found for provisional download of S${ep.arc_part}E${ep.episode_num}`);
  }

  // Single-episode releases are the norm; if a folder holds several, take the
  // largest as the primary and let batch-sibling processing pick up the rest.
  const primary = videos.length === 1
    ? videos[0]
    : videos.reduce((a, b) => (fileSize(b.filePath) > fileSize(a.filePath) ? b : a));

  const realCrc32 = primary.crc32;
  // Filename tag first; fall back to the arc's known resolution (e.g. Loguetown
  // is 480p) before the hardcoded 1080p, so a tagless release isn't mislabeled.
  const resolution =
    parseResolutionFromFilename(primary.filename)
    ?? (await getArcResolution(ep.arc_title))
    ?? "1080p";
  const ext = path.extname(primary.filePath);

  // Prefer full metadata if the catalog now lists this CRC32; otherwise build a
  // minimal record from what we parsed at queue time (arc/episode/extended).
  let meta: ResolvedEpisode;
  try {
    meta = await resolveEpisodeByCrc32(realCrc32, resolution);
  } catch {
    // The dataset doesn't list this CRC32 yet. Pull what we can from ladyisatis'
    // metadata sheet (episode/arc titles + descriptions) so Plex still gets real
    // text instead of blanks; fall back to empties when the sheet is off/missing.
    const [epText, arcText] = await Promise.all([
      lookupEpisodeText(ep.arc_title, ep.episode_num),
      lookupArcText(ep.arc_title),
    ]);
    logger.info("Provisional episode still not in dataset — using sheet/parsed metadata", {
      crc32: realCrc32, arc: ep.arc_title, episode: ep.episode_num, sheetHit: Boolean(epText),
    });
    meta = {
      crc32: realCrc32,
      arcIndex: ep.arc_num,
      arcTitle: ep.arc_title,
      arcSaga: arcText?.saga ?? "",
      arcPart: ep.arc_part,
      arcDescription: arcText?.description ?? "",
      episodeNum: ep.episode_num,
      episodeTitle: epText?.title ?? "",
      episodeDescription: epText?.description ?? "",
      chapters: "",
      originalEpisodes: "",
      released: "",
      resolution,
      extended: ep.extended,
    };
  }

  const finalFilename = buildPlexFilename(
    meta.arcTitle, meta.arcPart, meta.episodeNum, resolution, realCrc32, ext, meta.extended
  );
  const { replaced } = moveAndRename(
    primary.filePath, finalFilename, meta.arcTitle, meta.arcPart, meta.episodeNum
  );

  // Re-key the record: drop the synthetic PROV row, insert under the real CRC32.
  deleteEpisode(ep.crc32);
  upsertEpisode({
    crc32: realCrc32,
    arc_num: meta.arcIndex,
    arc_title: meta.arcTitle,
    arc_part: meta.arcPart,
    episode_num: meta.episodeNum,
    resolution,
    original_filename: primary.filename,
    final_filename: finalFilename,
    status: "done",
    torrent_hash: torrentHash,
    magnet_uri: null,
    error_message: null,
    rss_guid: ep.rss_guid,
    changelog: ep.changelog,
    extended: meta.extended,
  });
  logger.info("Provisional download imported", { provisionalKey: ep.crc32, crc32: realCrc32, filename: finalFilename });

  // The torrent may actually be a batch — pick up any other episodes in it.
  const siblings = await processBatchSiblings(path.dirname(primary.filePath), torrentHash, realCrc32);

  try {
    await triggerLibraryScan();
    await new Promise((resolve) => setTimeout(resolve, 5000));
    await syncSingleEpisode({
      ...meta,
      seasonEpisodeId: `s${String(meta.arcPart).padStart(2, "0")}e${String(meta.episodeNum).padStart(2, "0")}`,
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
    logger.warn("Plex scan/sync failed after provisional ingest — file is on disk, use Full Sync to recover", {
      crc32: realCrc32, error: (err as Error).message,
    });
  }

  if (getAutoPosters()) {
    const arcParts = new Set([meta.arcPart, ...siblings.map((s) => s.meta.arcPart)]);
    for (const arcPart of arcParts) await ensureSeasonPoster(arcPart);
  }

  await sendDiscordNotification({
    type: replaced.length > 0 ? "episode_updated" : "download_complete",
    crc32: realCrc32,
    arcTitle: meta.arcTitle,
    arcPart: meta.arcPart,
    episodeNum: meta.episodeNum,
    episodeTitle: meta.episodeTitle,
    filename: finalFilename,
    replacedFilenames: replaced,
    changelog: ep.changelog,
  });

  await getQbitClient().deleteTorrent(torrentHash, false);
  return true;
}

function fileSize(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
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

      // Provisional downloads have no real CRC32 yet — recover it from the file.
      if (isProvisionalKey(ep.crc32)) {
        const ok = await processProvisionalDownload(ep, ep.torrent_hash);
        if (ok) completed++;
        continue;
      }

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

  // Freshly-ingested episodes have metadata (from syncSingleEpisode) but no
  // thumbnail yet. When auto-reconcile is on, run a reconcile pass to adopt the
  // applied metadata state and trigger thumbnail generation for the new files.
  if (completed > 0 && getAutoReconcile()) {
    try {
      const r = await reconcilePlexMetadata({ thumbnails: true });
      logger.info("Reconcile after ingest complete", { completed, ...r });
    } catch (err) {
      logger.warn("Reconcile after ingest failed", { error: (err as Error).message });
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
