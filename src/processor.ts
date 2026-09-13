import fs from "fs";
import path from "path";
import { getConfig } from "./config";
import { DOWNLOAD_PATH, MEDIA_PATH } from "./constants";
import { logger } from "./logger";
import { getEpisodeByCrc32, getEpisodesByStatus, updateEpisodeStatus, upsertEpisode, deleteEpisode, recordDownloadProgress, getRetryableFailed, scheduleRetry, clearRetryState, type EpisodeRecord } from "./db";
import { getQbitClient, isTorrentComplete, type TorrentInfo } from "./qbittorrent";
import { resolveEpisodeByCrc32, buildPlexFilename, extractResolutionFromFilename, parseResolutionFromFilename, extractCrc32FromFilename, isProvisionalKey, getAllArcs, getAllEpisodes, getCatalogedCrc32s, parseReleaseFilename, resolveArcByTitle, type ResolvedEpisode } from "./metadata";
import { getArcResolution } from "./onepace-sheet";
import { buildSeasonFolder, findDownloadedFile, findExistingEpisodeFile, moveAndRename, scanBatchFiles, type BatchFile } from "./fileops";
import { triggerLibraryScan, syncSingleEpisode, syncFullLibrary } from "./plex";
import { sendDiscordNotification } from "./discord";
import { ensureSeasonPoster } from "./posters";
import { getAutoPosters, getAutoReconcile } from "./settings";
import { scanCoverage, getStoredCoverage } from "./coverage";
import { reconcilePlexMetadata } from "./metadata-audit";
import { lookupEpisodeText, lookupArcText } from "./onepace-descriptions";
import * as pixeldrainDownloads from "./pixeldrain-downloads";

/**
 * qBittorrent (or the VPN container in front of it) being unreachable says
 * nothing about the episode — it's infrastructure, and the very next poll may
 * well succeed. Errors matching this stay retryable instead of burning the
 * episode to "failed".
 */
const TRANSIENT_INFRA = /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up/i;

function isTransientInfraError(message: string): boolean {
  return TRANSIENT_INFRA.test(message);
}

/**
 * Guards against importing a release that is OLDER than the file already in the
 * library. One Pace's feed carries both the current release and its
 * predecessor, so the same episode can be queued twice with different CRC32s;
 * whichever finished last used to win, silently overwriting the newer file.
 *
 * The test mirrors the coverage report's: a CRC32 the dataset has never listed
 * came from a release that landed after the dataset was last generated, so it is
 * newer than anything the catalog knows — including the catalog's own canonical.
 * Returns the on-disk filename when the incoming file would be a downgrade.
 */
async function newerFileAlreadyOnDisk(
  arcTitle: string,
  arcPart: number,
  episodeNum: number,
  incomingCrc32: string
): Promise<string | null> {
  const existing = findExistingEpisodeFile(arcTitle, arcPart, episodeNum);
  if (!existing?.crc32) return null;
  const incoming = incomingCrc32.toUpperCase();
  if (existing.crc32 === incoming) return null;
  const cataloged = await getCatalogedCrc32s();
  if (!cataloged.has(existing.crc32) && cataloged.has(incoming)) return existing.filename;
  return null;
}

// A torrent absent from qBittorrent is usually gone for good, but a client that
// is still starting up can briefly return nothing. Require several consecutive
// misses before writing the episode off. In-memory on purpose: after a restart
// it is right to re-confirm rather than trust a stale count.
const MISSING_CONFIRM_COUNT = 3;
const _missingCounts = new Map<string, number>();

function countMissing(hash: string): number {
  const n = (_missingCounts.get(hash) ?? 0) + 1;
  _missingCounts.set(hash, n);
  return n;
}

function clearMissing(hash: string): void {
  _missingCounts.delete(hash);
}

interface BatchResult {
  crc32: string;
  meta: ResolvedEpisode;
  finalFilename: string;
  replaced: string[];
}

/**
 * Metadata for a batch file, resolved by CRC32 where the catalog knows it and
 * otherwise derived from the filename. The derived path matters for a release
 * that landed before the dataset regenerated: the CRC32 lookup fails, but
 * `[One Pace][252-254] Skypiea 08 [1080p][A1DFB514].mkv` still names its arc and
 * episode, and it is the NEWER file. Skipping it left the stale catalogued
 * release in the library.
 */
async function resolveBatchFileMeta(
  crc32: string,
  filename: string,
  resolution: string
): Promise<ResolvedEpisode> {
  try {
    return await resolveEpisodeByCrc32(crc32, resolution);
  } catch (err) {
    const parsed = parseReleaseFilename(filename);
    const arc = parsed ? await resolveArcByTitle(parsed.arcTitle) : null;
    if (!parsed || !arc) throw err; // genuinely unplaceable — keep the original error

    const [epText, arcText] = await Promise.all([
      lookupEpisodeText(arc.arcTitle, parsed.epNum),
      lookupArcText(arc.arcTitle),
    ]);
    logger.info("Batch file not in dataset — placing from filename", {
      crc32, file: filename, arc: arc.arcTitle, episode: parsed.epNum, sheetHit: Boolean(epText),
    });
    return {
      crc32,
      arcIndex: arc.arcIndex,
      arcTitle: arc.arcTitle,
      arcSaga: arc.arcSaga ?? arcText?.saga ?? "",
      arcPart: arc.arcPart,
      arcDescription: arc.arcDescription ?? arcText?.description ?? "",
      episodeNum: parsed.epNum,
      episodeTitle: epText?.title ?? "",
      episodeDescription: epText?.description ?? "",
      chapters: "",
      originalEpisodes: "",
      released: "",
      resolution,
      extended: parsed.extended,
    };
  }
}

/**
 * After the primary episode file has been moved, scan the same torrent subfolder
 * for sibling files. Each one is placed by CRC32 where the dataset knows it and
 * by filename otherwise, moved to the Plex library and marked done. Files that
 * can be placed neither way are skipped with a warning.
 */
async function processBatchSiblings(
  batchDir: string,
  torrentHash: string | null,
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
      const meta = await resolveBatchFileMeta(sibling.crc32, sibling.filename, resolution);

      const newer = await newerFileAlreadyOnDisk(meta.arcTitle, meta.arcPart, meta.episodeNum, sibling.crc32);
      if (newer) {
        logger.info("Skipping batch file — a newer release is already in the library", {
          crc32: sibling.crc32, file: sibling.filename, keeping: newer,
        });
        continue;
      }

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
 * Imports whatever a completed torrent actually delivered, rather than what we
 * expected it to. Finds the video file, recovers its CRC32 + resolution, resolves
 * metadata (falling back to the arc/episode known at queue time when the catalog
 * still lacks it), moves it, and re-keys the DB record onto the real CRC32.
 *
 * Two callers need this. A provisional download has no real CRC32 yet, by
 * definition. And a normal download can deliver a *different* CRC32 than the feed
 * advertised — One Pace re-uploads an episode and the feed entry still carries the
 * superseded hash — which used to fail as "Downloaded file not found" even though
 * the episode was sitting there, correctly downloaded.
 *
 * Returns true if a file was successfully imported.
 */
async function importTorrentContents(ep: EpisodeRecord, torrentHash: string): Promise<boolean> {
  const torrent = await getQbitClient().getTorrent(torrentHash);
  if (!torrent) throw new Error(`Torrent ${torrentHash} not found in qBittorrent`);

  const videos = locateTorrentVideos(torrent);
  if (videos.length === 0) {
    throw new Error(`No CRC32-tagged video found in the torrent for S${ep.arc_part}E${ep.episode_num}`);
  }
  return importVideos(ep, videos, torrentHash);
}

/**
 * Imports already-downloaded video files for an episode, whatever fetched them.
 * `torrentHash` is null for a direct HTTP download, in which case there is no
 * torrent to clean up afterwards.
 */
async function importVideos(
  ep: EpisodeRecord,
  videos: BatchFile[],
  torrentHash: string | null
): Promise<boolean> {

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
    logger.info("Episode not in dataset — using sheet/parsed metadata", {
      crc32: realCrc32, arc: ep.arc_title, episode: ep.episode_num, sheetHit: Boolean(epText),
      published: ep.published_at ?? "(none)",
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
      // The catalog has no air date for this release yet; the feed's publication
      // date is the best available stand-in. Reconcile replaces it with the
      // dataset's own date once the episode is listed.
      released: ep.published_at ?? "",
      resolution,
      extended: ep.extended,
    };
  }

  const newer = await newerFileAlreadyOnDisk(meta.arcTitle, meta.arcPart, meta.episodeNum, realCrc32);
  if (newer) {
    logger.info("Skipping older release — a newer file is already in the library", {
      crc32: realCrc32, arc: meta.arcTitle, episode: meta.episodeNum, keeping: newer,
    });
    deleteEpisode(ep.crc32);
    if (torrentHash) await safeDeleteTorrent(torrentHash);
    return false;
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
    // Carry the sources across the re-key: a later coverage upgrade or manual
    // re-download would otherwise find the row with no way to fetch it again.
    magnet_uri: ep.magnet_uri,
    pixeldrain_id: ep.pixeldrain_id,
    error_message: null,
    rss_guid: ep.rss_guid,
    changelog: ep.changelog,
    extended: meta.extended,
  });
  logger.info("Imported from torrent contents", { queuedAs: ep.crc32, crc32: realCrc32, filename: finalFilename });

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

  if (torrentHash) await safeDeleteTorrent(torrentHash);
  return true;
}

/**
 * Torrent cleanup is housekeeping: the file is already in the library by the
 * time this runs, so a qBittorrent hiccup here must not flip a successful
 * import to "failed".
 */
async function safeDeleteTorrent(hash: string): Promise<void> {
  try {
    await getQbitClient().deleteTorrent(hash, false);
  } catch (err) {
    logger.warn("Could not remove torrent from qBittorrent — file is already imported", {
      hash, error: (err as Error).message,
    });
  }
}

function fileSize(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

let _processing = false;
let _reconcilingAfterIngest = false;

export async function processDownloading(): Promise<void> {
  // The 30s interval and the cron cycle can both call this; never run two at once
  // (would double-process the same episode if one run exceeds the interval).
  if (_processing) return;
  _processing = true;
  let completed = false;
  try {
    completed = await _processDownloading();
  } finally {
    _processing = false;
  }

  // Reconcile OUTSIDE the download-check guard. It's heavy (full Plex scan +
  // thumbnail analysis + ffmpeg), so running it while _processing is held would
  // freeze completion detection — and completion is what fires the "download
  // complete" notifications. Kept single-flight via its own flag; while it runs,
  // the 30s interval keeps detecting and notifying new completions normally.
  if (completed && getAutoReconcile() && !_reconcilingAfterIngest) {
    _reconcilingAfterIngest = true;
    try {
      const r = await reconcilePlexMetadata({ thumbnails: true });
      logger.info("Reconcile after ingest complete", { ...r });
    } catch (err) {
      logger.warn("Reconcile after ingest failed", { error: (err as Error).message });
    } finally {
      _reconcilingAfterIngest = false;
    }
  }
}

// Automatic recovery for episodes that failed. Most failures this system sees
// are environmental — the client restarted, the VPN dropped, a source was briefly
// unreachable — and used to need a human to press "Retry failed". Attempts are
// capped and spaced out so a genuinely broken episode settles into "failed"
// rather than re-downloading forever; a manual retry resets the count.
const MAX_AUTO_RETRIES = 3;
const RETRY_BACKOFF_MS = [5 * 60_000, 20 * 60_000, 60 * 60_000];

export async function requeueRetryableFailures(): Promise<number> {
  const due = getRetryableFailed(MAX_AUTO_RETRIES);
  let requeued = 0;
  for (const ep of due) {
    const attempts = ep.attempts + 1;
    // attempts is 1-based here, so the first retry takes the first delay.
    const backoff = RETRY_BACKOFF_MS[Math.min(attempts - 1, RETRY_BACKOFF_MS.length - 1)];
    scheduleRetry(ep.crc32, attempts, Date.now() + backoff);
    updateEpisodeStatus(ep.crc32, "pending", { error_message: null });
    logger.info("Auto-retrying failed episode", {
      crc32: ep.crc32, attempt: attempts, of: MAX_AUTO_RETRIES,
      previousError: ep.error_message ?? "(none)",
    });
    requeued++;
  }
  return requeued;
}

/**
 * One sweep's worth of work for an episode being fetched over HTTPS: import it
 * if the file has landed, otherwise make sure a transfer is running. Returns
 * true when an episode was imported.
 *
 * Completion is judged from the filesystem, so a restart mid-transfer picks up
 * where it left off instead of re-downloading.
 */
async function advancePixeldrainDownload(ep: EpisodeRecord): Promise<boolean> {
  if (!pixeldrainDownloads.isComplete(ep)) {
    if (!pixeldrainDownloads.isTransferActive(ep.crc32)) pixeldrainDownloads.startTransfer(ep);
    return false;
  }

  logger.info("Download complete, processing", { crc32: ep.crc32, via: "pixeldrain" });
  updateEpisodeStatus(ep.crc32, "processing");

  const filePath = pixeldrainDownloads.destinationFor(ep.original_filename);
  const crc32 = extractCrc32FromFilename(ep.original_filename);
  if (!crc32) {
    throw new Error(`Pixeldrain file has no CRC32 in its name: ${ep.original_filename}`);
  }

  // Same importer as the torrent path — it resolves metadata by the real CRC32,
  // refuses a downgrade, moves the file and re-keys the row. There is no torrent
  // to clean up, hence the null.
  return importVideos(ep, [{ filePath, filename: ep.original_filename, crc32 }], null);
}

async function _processDownloading(): Promise<boolean> {
  const downloading = getEpisodesByStatus("downloading");
  if (downloading.length === 0) return false;

  const qbit = getQbitClient();
  let completed = 0;

  for (const ep of downloading) {
    if (ep.download_via === "pixeldrain") {
      try {
        if (await advancePixeldrainDownload(ep)) completed++;
      } catch (err) {
        const msg = (err as Error).message;
        logger.error("Failed to import Pixeldrain download", { crc32: ep.crc32, error: msg });
        updateEpisodeStatus(ep.crc32, "failed", { error_message: msg });
        await sendDiscordNotification({ type: "error", crc32: ep.crc32, error: msg });
      }
      continue;
    }

    if (!ep.torrent_hash) continue;

    try {
      // One fetch drives all three questions: is it done, is it advancing, and is
      // it still there at all. isComplete() would re-fetch for the first alone.
      const torrent = await qbit.getTorrent(ep.torrent_hash);

      if (!torrent) {
        // Gone from qBittorrent — removed by hand, lost with the client's state,
        // or moved out of our category. Waiting for it to complete is futile, but
        // one missing reading could just be a client still warming up, so require
        // a few consecutive misses before calling it.
        if (countMissing(ep.torrent_hash) < MISSING_CONFIRM_COUNT) {
          logger.debug("Torrent not found this pass", { crc32: ep.crc32, hash: ep.torrent_hash });
          continue;
        }
        clearMissing(ep.torrent_hash);
        const msg = "Torrent is no longer in qBittorrent — it was removed, lost, or re-categorised";
        logger.warn("Download abandoned", { crc32: ep.crc32, hash: ep.torrent_hash });
        updateEpisodeStatus(ep.crc32, "failed", { error_message: msg });
        continue;
      }
      clearMissing(ep.torrent_hash);

      const done = isTorrentComplete(torrent);
      if (!done) {
        recordDownloadProgress(ep.crc32, torrent.progress);
        logger.debug("Still downloading", {
          crc32: ep.crc32, hash: ep.torrent_hash, progress: torrent.progress, state: torrent.state,
        });
        continue;
      }

      logger.info("Download complete, processing", { crc32: ep.crc32 });
      updateEpisodeStatus(ep.crc32, "processing");

      // Provisional downloads have no real CRC32 yet — recover it from the file.
      if (isProvisionalKey(ep.crc32)) {
        const ok = await importTorrentContents(ep, ep.torrent_hash);
        if (ok) completed++;
        continue;
      }

      const sourcePath = findDownloadedFile(DOWNLOAD_PATH, ep.crc32);
      if (!sourcePath) {
        // The torrent completed but holds no file with the CRC32 we queued under.
        // That means the feed advertised a hash the torrent doesn't carry — a
        // re-upload where the entry still names the superseded release. Import
        // what the torrent actually contains instead of failing.
        logger.info("Queued CRC32 not present in the download — importing the torrent's actual contents", {
          crc32: ep.crc32, arc: ep.arc_title, episode: ep.episode_num,
        });
        const ok = await importTorrentContents(ep, ep.torrent_hash);
        if (ok) completed++;
        continue;
      }

      const epMeta = await resolveEpisodeByCrc32(ep.crc32, ep.resolution);

      // One Pace's feed lists a re-release alongside the release it replaces, so
      // both can be queued for the same slot. Never let the older one land on top.
      const newer = await newerFileAlreadyOnDisk(epMeta.arcTitle, ep.arc_part, ep.episode_num, ep.crc32);
      if (newer) {
        logger.info("Skipping older release — a newer file is already in the library", {
          crc32: ep.crc32, arc: ep.arc_title, episode: ep.episode_num, keeping: newer,
        });
        updateEpisodeStatus(ep.crc32, "done", { final_filename: newer, error_message: null });
        await safeDeleteTorrent(ep.torrent_hash);
        continue;
      }

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
      clearRetryState(ep.crc32);
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
      await safeDeleteTorrent(ep.torrent_hash);
    } catch (err) {
      const msg = (err as Error).message;

      // qBittorrent unreachable (its container restarting, the VPN sidecar
      // reconnecting) tells us nothing about this episode. Put it back to
      // "downloading" so the next poll picks it up, and stop the sweep — every
      // remaining episode would fail the same way and clear the pipeline into
      // "failed" for what is a passing outage.
      if (isTransientInfraError(msg) && getEpisodeByCrc32(ep.crc32)?.status === "processing") {
        updateEpisodeStatus(ep.crc32, "downloading", { error_message: null });
        logger.warn("qBittorrent unreachable — leaving episode queued for the next poll", {
          crc32: ep.crc32, error: msg,
        });
        break;
      }

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

  // The post-ingest reconcile (metadata state + thumbnail generation for the new
  // files) is run by the caller, outside the download-check guard — see
  // processDownloading. It must not block completion detection here.
  return completed > 0;
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
    // A human asking is a fresh start: clear the automatic attempt budget so an
    // episode that exhausted it becomes eligible again.
    clearRetryState(ep.crc32);
    pixeldrainDownloads.clearTransferFailures(ep.crc32);
    updateEpisodeStatus(ep.crc32, "pending", { error_message: null });
  }
}
