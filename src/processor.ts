import path from "path";
import { getConfig } from "./config";
import { DOWNLOAD_PATH } from "./constants";
import { logger } from "./logger";
import { getEpisodesByStatus, updateEpisodeStatus } from "./db";
import { getQbitClient } from "./qbittorrent";
import { resolveEpisodeByCrc32, buildPlexFilename, getAllArcs, getAllEpisodes } from "./metadata";
import { findDownloadedFile, moveAndRename } from "./fileops";
import { triggerLibraryScan, syncSingleEpisode, syncFullLibrary } from "./plex";
import { sendDiscordNotification } from "./discord";

export async function processDownloading(): Promise<void> {
  const downloading = getEpisodesByStatus("downloading");
  if (downloading.length === 0) return;

  const qbit = getQbitClient();

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

      const ext = path.extname(sourcePath);
      const finalFilename = buildPlexFilename(
        ep.arc_title,
        ep.arc_part,
        ep.episode_num,
        ep.resolution,
        ep.crc32,
        ext
      );

      const destPath = moveAndRename(sourcePath, finalFilename, ep.arc_title, ep.arc_part);

      const epMeta = await resolveEpisodeByCrc32(ep.crc32, ep.resolution);

      await triggerLibraryScan();
      await new Promise((resolve) => setTimeout(resolve, 5000));
      await syncSingleEpisode({
        ...epMeta,
        seasonEpisodeId: `s${String(ep.arc_part).padStart(2, "0")}e${String(ep.episode_num).padStart(2, "0")}`,
      });

      updateEpisodeStatus(ep.crc32, "done", { final_filename: finalFilename });

      await runMetadataSync();

      await sendDiscordNotification({
        type: "download_complete",
        crc32: ep.crc32,
        arcTitle: ep.arc_title,
        arcPart: ep.arc_part,
        episodeNum: ep.episode_num,
        episodeTitle: epMeta.episodeTitle,
        filename: finalFilename,
      });

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
