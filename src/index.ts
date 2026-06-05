import cron from "node-cron";
import { getConfig } from "./config";
import { logger } from "./logger";
import { isGuidSeen, markGuidSeen, upsertEpisode, updateEpisodeStatus, getEpisodesByStatus } from "./db";
import { fetchNewEpisodes } from "./rss";
import { resolveEpisodeByCrc32, extractResolutionFromFilename } from "./metadata";
import { getQbitClient } from "./qbittorrent";
import { processDownloading } from "./processor";
import { sendDiscordNotification } from "./discord";
import { ensureDir } from "./fileops";

async function pollRss(): Promise<void> {
  logger.info("Starting RSS poll cycle");

  let newEpisodes;
  try {
    newEpisodes = await fetchNewEpisodes(isGuidSeen);
  } catch (err) {
    logger.error("RSS poll failed", { error: (err as Error).message });
    return;
  }

  for (const rssEp of newEpisodes) {
    try {
      logger.info("Processing new RSS entry", { crc32: rssEp.crc32, title: rssEp.title });

      const resolution = extractResolutionFromFilename(rssEp.filename);
      const ep = await resolveEpisodeByCrc32(rssEp.crc32, resolution);

      upsertEpisode({
        crc32: rssEp.crc32,
        arc_num: ep.arcIndex,
        arc_title: ep.arcTitle,
        arc_part: ep.arcPart,
        episode_num: ep.episodeNum,
        resolution: ep.resolution,
        original_filename: rssEp.filename,
        final_filename: null,
        status: "pending",
        torrent_hash: null,
        magnet_uri: rssEp.magnet,
        error_message: null,
        rss_guid: rssEp.guid,
      });

      markGuidSeen(rssEp.guid);

      // Dispatch to qBittorrent immediately
      const qbit = getQbitClient();
      const torrentHash = await qbit.addMagnet(rssEp.magnet);
      updateEpisodeStatus(rssEp.crc32, "downloading", { torrent_hash: torrentHash });
      logger.info("Episode queued for download", {
        crc32: rssEp.crc32,
        arc: ep.arcTitle,
        episode: ep.episodeNum,
        torrentHash,
      });

      await sendDiscordNotification({
        type: "new_episode",
        crc32: rssEp.crc32,
        arcTitle: ep.arcTitle,
        arcPart: ep.arcPart,
        episodeNum: ep.episodeNum,
      });
    } catch (err) {
      logger.error("Failed to process RSS entry", {
        crc32: rssEp.crc32,
        error: (err as Error).message,
      });
    }
  }
}

async function dispatchPending(): Promise<void> {
  const pending = getEpisodesByStatus("pending");
  if (pending.length === 0) return;

  const qbit = getQbitClient();
  logger.info(`Dispatching ${pending.length} pending episode(s) to qBittorrent`);

  for (const ep of pending) {
    if (!ep.magnet_uri) {
      logger.warn("Pending episode has no stored magnet URI, skipping", { crc32: ep.crc32 });
      continue;
    }
    try {
      const torrentHash = await qbit.addMagnet(ep.magnet_uri);
      updateEpisodeStatus(ep.crc32, "downloading", { torrent_hash: torrentHash });
      logger.info("Dispatched pending episode", { crc32: ep.crc32, torrentHash });
    } catch (err) {
      logger.error("Failed to dispatch pending episode", { crc32: ep.crc32, error: (err as Error).message });
    }
  }
}

async function runCycle(): Promise<void> {
  await pollRss();
  await processDownloading();
}

async function bootstrap(): Promise<void> {
  const config = getConfig(); // validates config, throws if invalid

  ensureDir(config.DATA_DIR);
  ensureDir(config.QBIT_DOWNLOAD_PATH);

  logger.info("One Pace Plex Automator starting", {
    pollIntervalMinutes: config.POLL_INTERVAL_MINUTES,
    mediaPath: config.MEDIA_PATH,
  });

  // Run immediately on startup
  await runCycle();

  // Schedule recurring poll
  const cronExpr = `*/${config.POLL_INTERVAL_MINUTES} * * * *`;
  cron.schedule(cronExpr, async () => {
    try {
      await runCycle();
    } catch (err) {
      logger.error("Unhandled error in poll cycle", { error: (err as Error).message });
    }
  });

  // Check in-progress downloads more frequently
  cron.schedule("*/5 * * * *", async () => {
    try {
      await processDownloading();
    } catch (err) {
      logger.error("Unhandled error in download check", { error: (err as Error).message });
    }
  });

  logger.info(`Scheduled RSS poll every ${config.POLL_INTERVAL_MINUTES} minutes`);
}

bootstrap().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
