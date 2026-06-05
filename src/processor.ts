import path from "path";
import { getConfig } from "./config";
import { logger } from "./logger";
import { getEpisodesByStatus, updateEpisodeStatus } from "./db";
import { getQbitClient } from "./qbittorrent";
import { resolveEpisodeByCrc32, buildPlexFilename } from "./metadata";
import { findDownloadedFile, moveAndRename } from "./fileops";
import {
  triggerLibraryScan,
  findEpisodeRatingKey,
  updateEpisodeMetadata,
} from "./plex";
import { sendDiscordNotification } from "./discord";

export async function processDownloading(): Promise<void> {
  const downloading = getEpisodesByStatus("downloading");
  if (downloading.length === 0) return;

  const qbit = getQbitClient();
  const { QBIT_DOWNLOAD_PATH, PLEX_LIBRARY_SECTION_ID, PLEX_SERIES_RATING_KEY } = getConfig();

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

      const sourcePath = findDownloadedFile(QBIT_DOWNLOAD_PATH, ep.crc32);
      if (!sourcePath) {
        throw new Error(`Downloaded file not found in ${QBIT_DOWNLOAD_PATH} for CRC32 ${ep.crc32}`);
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

      // Plex: scan library then update metadata
      await triggerLibraryScan(PLEX_LIBRARY_SECTION_ID);

      // Wait briefly for Plex to index the new file before updating metadata
      await new Promise((resolve) => setTimeout(resolve, 5000));

      const ratingKey = await findEpisodeRatingKey(
        PLEX_LIBRARY_SECTION_ID,
        PLEX_SERIES_RATING_KEY,
        ep.arc_part,
        ep.episode_num
      );

      const epMeta = await resolveEpisodeByCrc32(ep.crc32, ep.resolution);

      if (ratingKey) {
        await updateEpisodeMetadata(ratingKey, epMeta.episodeTitle, epMeta.episodeDescription);
        logger.info("Plex metadata updated", { ratingKey, title: epMeta.episodeTitle });
      } else {
        logger.warn("Could not find episode in Plex to update metadata", {
          crc32: ep.crc32,
          season: ep.arc_part,
          episode: ep.episode_num,
        });
      }

      updateEpisodeStatus(ep.crc32, "done", { final_filename: finalFilename });

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

export async function retryFailed(): Promise<void> {
  const failed = getEpisodesByStatus("failed");
  for (const ep of failed) {
    logger.info("Retrying failed episode", { crc32: ep.crc32 });
    updateEpisodeStatus(ep.crc32, "pending", { error_message: null });
  }
}
