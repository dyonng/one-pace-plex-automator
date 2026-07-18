import { runCycle, dispatchPending } from "./cycle";
import { runMetadataSync, retryFailed } from "./processor";
import { syncPosters } from "./posters";
import { refreshMetadata, clearMetadataCache, resolveEpisodeByCrc32, extractResolutionFromFilename } from "./metadata";
import { getEpisodeByCrc32, getKv, updateEpisodeStatus, deleteEpisode, upsertEpisode, clearDoneEpisodes } from "./db";
import { getQbitClient } from "./qbittorrent";
import { syncSingleEpisode, triggerLibraryScan } from "./plex";
import { deleteEpisodeFile } from "./fileops";
import { findMagnetByCrc32 } from "./rss";
import { refreshCoverageIfPresent } from "./coverage";
import { applyNamingRenames } from "./naming";
import { clearSheetCache, prefetchSheet } from "./onepace-sheet";
import { clearDescriptionsCache, prefetchDescriptions } from "./onepace-descriptions";
import { scanMetadataAudit, reconcilePlexMetadata, markDirtyFromSource, retryThumbnails } from "./metadata-audit";
import { getAutoReconcile } from "./settings";
import { logger } from "./logger";

export interface Runtime {
  startedAt: number;
  lastPollAt: number | null;
  lastSyncAt: number | null;
  lastRetryAt: number | null;
}

export const runtime: Runtime = {
  startedAt: Date.now(),
  lastPollAt: null,
  lastSyncAt: null,
  lastRetryAt: null,
};

// Serialize actions so a manual trigger never overlaps the cron cycle or another
// manual trigger (they share qBit/Plex/DB state).
let _running = false;
let _runningLabel: string | null = null;

export function isBusy(): boolean {
  return _running;
}

export function busyLabel(): string | null {
  return _runningLabel;
}

async function withLock<T>(label: string, fn: () => Promise<T>): Promise<T> {
  if (_running) throw new Error(`Busy: "${_runningLabel}" is already running`);
  _running = true;
  _runningLabel = label;
  try {
    return await fn();
  } finally {
    _running = false;
    _runningLabel = null;
  }
}

export type ActionId =
  | "refresh-sources"
  | "sync"
  | "metadata-scan"
  | "metadata-sync"
  | "retry-thumbs"
  | "retry-failed"
  | "clear-done";

export interface ActionResult {
  ok: boolean;
  message: string;
}

export async function runAction(id: ActionId): Promise<ActionResult> {
  switch (id) {
    case "refresh-sources":
      return withLock("Refresh sources", async () => {
        clearMetadataCache();
        clearSheetCache();
        clearDescriptionsCache();
        await refreshMetadata();
        // Eagerly warm both sheet caches so success/failure is logged now.
        await Promise.all([prefetchSheet(), prefetchDescriptions()]);
        await runCycle();
        runtime.lastPollAt = Date.now();

        // The source data may have changed — recompute desired metadata so the
        // audit reflects it. When auto-reconcile is on, push the changes (and
        // any pending thumbnails) to Plex now; otherwise just mark them dirty.
        let reconcileMsg = "";
        try {
          if (getAutoReconcile()) {
            const r = await reconcilePlexMetadata({ thumbnails: true });
            runtime.lastSyncAt = Date.now();
            if (r.episodesUpdated || r.seasonsUpdated || r.thumbsTriggered || r.thumbsGenerated) {
              reconcileMsg =
                ` Reconciled ${r.episodesUpdated} episode(s)` +
                `${r.seasonsUpdated ? `, ${r.seasonsUpdated} season(s)` : ""}` +
                `${r.thumbsTriggered ? `, ${r.thumbsTriggered} thumbnail(s)` : ""}` +
                `${r.thumbsGenerated ? `, ${r.thumbsGenerated} custom thumbnail(s)` : ""}.`;
            }
          } else {
            await markDirtyFromSource();
          }
        } catch (err) {
          logger.warn("Reconcile after refresh-sources failed", { error: (err as Error).message });
        }

        return { ok: true, message: `Sources refreshed and RSS poll complete.${reconcileMsg}` };
      });

    case "sync":
      return withLock("Full Plex sync", async () => {
        await runMetadataSync();
        const posters = await syncPosters();
        runtime.lastSyncAt = Date.now();
        return {
          ok: true,
          message: `Full Plex sync complete. Posters: ${posters.applied} applied, ${posters.skipped} up to date`,
        };
      });

    case "metadata-scan":
      return withLock("Metadata scan", async () => {
        const report = await scanMetadataAudit();
        const { flagged, missing, drifted, notInPlex } = report.totals;
        return {
          ok: true,
          message:
            flagged === 0 && report.seasonsFlagged === 0
              ? "Metadata audit: everything is up to date"
              : `Metadata audit: ${flagged} flagged (${missing} missing, ${drifted} drifted)` +
                `${report.seasonsFlagged ? `, ${report.seasonsFlagged} season(s)` : ""}` +
                `${notInPlex ? `, ${notInPlex} not in Plex` : ""}`,
        };
      });

    case "metadata-sync":
      return withLock("Metadata reconcile", async () => {
        const r = await reconcilePlexMetadata({ thumbnails: true });
        runtime.lastSyncAt = Date.now();
        const total = r.episodesUpdated + r.seasonsUpdated + r.thumbsTriggered + r.thumbsGenerated;
        return {
          ok: true,
          message:
            total === 0
              ? "Plex metadata & thumbnails already up to date — nothing to do"
              : `Reconciled ${r.episodesUpdated} episode(s)` +
                `${r.seasonsUpdated ? `, ${r.seasonsUpdated} season(s)` : ""}` +
                `${r.thumbsTriggered ? `, triggered ${r.thumbsTriggered} thumbnail(s)` : ""}` +
                `${r.thumbsGenerated ? `, generated ${r.thumbsGenerated} custom thumbnail(s)` : ""}`,
        };
      });

    case "retry-thumbs":
      return withLock("Retry thumbnails", async () => {
        const r = await retryThumbnails();
        return {
          ok: true,
          message:
            r.thumbsTriggered === 0 && r.thumbsGenerated === 0
              ? "No episodes are missing thumbnails"
              : `Requested thumbnail generation for ${r.thumbsTriggered} episode(s)` +
                `${r.thumbsGenerated ? `, generated ${r.thumbsGenerated} custom` : ""}` +
                `${r.reset ? ` (reset ${r.reset} attempt counter(s))` : ""}. ` +
                "Plex generates them in the background — re-scan in a few minutes.",
        };
      });

    case "retry-failed":
      return withLock("Retry failed", async () => {
        await retryFailed();
        await dispatchPending();
        runtime.lastRetryAt = Date.now();
        return { ok: true, message: "Failed episodes re-queued" };
      });

    case "clear-done":
      return withLock("Clear done", async () => {
        const n = clearDoneEpisodes();
        return { ok: true, message: `Cleared ${n} completed episode${n === 1 ? "" : "s"} from the pipeline` };
      });

    default:
      throw new Error(`Unknown action: ${id}`);
  }
}

// ---- per-episode actions ----

function seasonEpisodeId(arcPart: number, episodeNum: number): string {
  return `s${String(arcPart).padStart(2, "0")}e${String(episodeNum).padStart(2, "0")}`;
}

export type EpisodeActionId = "download" | "retry" | "resync" | "remove" | "upgrade" | "download-source";

export async function runEpisodeAction(
  action: EpisodeActionId,
  crc32: string,
  opts: { deleteFile?: boolean; source?: string; title?: string } = {}
): Promise<ActionResult> {
  if (action === "download-source") {
    const source = opts.source ?? "";
    if (!source) return { ok: false, message: "No source URL provided" };
    const resolution = extractResolutionFromFilename(opts.title ?? "") || undefined;
    return withLock("Download episode", async () => {
      const existing = getEpisodeByCrc32(crc32);
      if (existing?.status === "downloading" || existing?.status === "processing") {
        return { ok: false, message: `Already ${existing.status}` };
      }
      let record = existing;
      if (!record) {
        let meta;
        try {
          meta = await resolveEpisodeByCrc32(crc32, resolution);
        } catch {
          return { ok: false, message: `Episode metadata not found for ${crc32}` };
        }
        upsertEpisode({
          crc32,
          arc_num: meta.arcIndex,
          arc_title: meta.arcTitle,
          arc_part: meta.arcPart,
          episode_num: meta.episodeNum,
          resolution: meta.resolution,
          original_filename: "",
          final_filename: null,
          status: "available",
          torrent_hash: null,
          magnet_uri: source,
          error_message: null,
          rss_guid: "",
          changelog: [],
          extended: meta.extended,
        });
        record = getEpisodeByCrc32(crc32)!;
      } else {
        upsertEpisode({ ...record, magnet_uri: source, status: "available", error_message: null });
        record = getEpisodeByCrc32(crc32)!;
      }
      const torrentHash = await getQbitClient().addMagnet(source);
      updateEpisodeStatus(crc32, "downloading", { torrent_hash: torrentHash, error_message: null });
      logger.info("Episode download started via interactive search", { crc32, torrentHash });
      return { ok: true, message: `Download started: S${record.arc_part}E${record.episode_num}` };
    });
  }

  if (action === "upgrade") {
    return withLock("Upgrade episode", async () => {
      let record = getEpisodeByCrc32(crc32);

      if (!record?.magnet_uri) {
        // Check the KV cache populated by the coverage scan before hitting the RSS live.
        const kvRaw = getKv(`magnet:${crc32.toUpperCase()}`);
        const rssItem = kvRaw
          ? (JSON.parse(kvRaw) as { magnet: string; guid: string; filename: string; changelog: string[] })
          : await findMagnetByCrc32(crc32);

        if (!rssItem) return { ok: false, message: "No magnet found — episode not in RSS feed" };

        const meta = await resolveEpisodeByCrc32(crc32, extractResolutionFromFilename(rssItem.filename));
        upsertEpisode({
          crc32,
          arc_num: meta.arcIndex,
          arc_title: meta.arcTitle,
          arc_part: meta.arcPart,
          episode_num: meta.episodeNum,
          resolution: meta.resolution,
          original_filename: rssItem.filename,
          final_filename: null,
          status: "available",
          torrent_hash: null,
          magnet_uri: rssItem.magnet,
          error_message: null,
          rss_guid: rssItem.guid,
          changelog: rssItem.changelog,
          extended: meta.extended,
        });
        record = getEpisodeByCrc32(crc32)!;
      }

      if (record.status === "downloading" || record.status === "processing") {
        return { ok: false, message: `Already ${record.status}` };
      }

      const torrentHash = await getQbitClient().addMagnet(record.magnet_uri!);
      updateEpisodeStatus(crc32, "downloading", { torrent_hash: torrentHash, error_message: null });
      await refreshCoverageIfPresent();
      logger.info("Episode upgrade queued from dashboard", { crc32, torrentHash });
      return { ok: true, message: `Upgrade started: S${record.arc_part}E${record.episode_num}` };
    });
  }

  const ep = getEpisodeByCrc32(crc32);
  if (!ep) return { ok: false, message: `Episode ${crc32} not found` };

  switch (action) {
    case "download":
    case "retry":
      return withLock(action === "retry" ? "Retry episode" : "Download episode", async () => {
        if (!ep.magnet_uri) return { ok: false, message: "No magnet stored for this episode" };
        if (ep.status === "downloading" || ep.status === "processing") {
          return { ok: false, message: `Already ${ep.status}` };
        }
        const torrentHash = await getQbitClient().addMagnet(ep.magnet_uri);
        updateEpisodeStatus(crc32, "downloading", { torrent_hash: torrentHash, error_message: null });
        await refreshCoverageIfPresent();
        logger.info("Episode download started from dashboard", { crc32, torrentHash });
        return { ok: true, message: `Download started: S${ep.arc_part}E${ep.episode_num}` };
      });

    case "resync":
      return withLock("Re-sync episode", async () => {
        const meta = await resolveEpisodeByCrc32(crc32, ep.resolution);
        await syncSingleEpisode({ ...meta, seasonEpisodeId: seasonEpisodeId(ep.arc_part, ep.episode_num) });
        return { ok: true, message: `Re-synced S${ep.arc_part}E${ep.episode_num} to Plex` };
      });

    case "remove":
      return withLock("Remove episode", async () => {
        let deletedFile = false;
        if (opts.deleteFile && ep.final_filename) {
          deletedFile = deleteEpisodeFile(ep.arc_title, ep.arc_part, ep.final_filename);
        }
        // If the episode is still in the pipeline (e.g. a stalled download),
        // cancel its torrent and drop the partial data so removing it fully
        // resets state — the user can retry the download/upgrade later.
        const inFlight =
          ep.status === "pending" || ep.status === "downloading" || ep.status === "processing";
        if (inFlight && ep.torrent_hash) {
          try {
            await getQbitClient().deleteTorrent(ep.torrent_hash, true);
            logger.info("Cancelled in-flight torrent on remove", { crc32, hash: ep.torrent_hash });
          } catch (err) {
            logger.warn("Failed to cancel torrent on remove", { crc32, error: (err as Error).message });
          }
        }
        deleteEpisode(crc32);
        await refreshCoverageIfPresent();
        logger.info("Episode removed from dashboard", { crc32, deletedFile });
        return { ok: true, message: `Removed S${ep.arc_part}E${ep.episode_num}${deletedFile ? " + file" : ""}` };
      });

    default:
      return { ok: false, message: `Unknown episode action: ${action}` };
  }
}

/**
 * Renames the given files (by CRC32) to the canonical naming scheme. Runs under
 * the action lock so it never overlaps the download processor's file moves, and
 * triggers a Plex scan + coverage refresh afterwards.
 */
export async function runNormalizeNaming(crc32s: string[]): Promise<ActionResult> {
  return withLock("Normalize file naming", async () => {
    const r = await applyNamingRenames(crc32s);
    if (r.renamed > 0) {
      try {
        await triggerLibraryScan();
      } catch (err) {
        logger.warn("Plex scan after rename failed", { error: (err as Error).message });
      }
      await refreshCoverageIfPresent();
    }
    const msg =
      `Renamed ${r.renamed} file${r.renamed === 1 ? "" : "s"}` +
      (r.failed > 0 ? `, ${r.failed} failed` : "");
    return { ok: r.failed === 0, message: msg };
  });
}
