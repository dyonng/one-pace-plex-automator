import { logger } from "./logger";
import { isGuidSeen, markGuidSeen, upsertEpisode, updateEpisodeStatus, getEpisodesByStatus } from "./db";
import { fetchNewEpisodes } from "./rss";
import { resolveEpisodeByCrc32, extractResolutionFromFilename, isPreferredRelease } from "./metadata";
import { getQbitClient } from "./qbittorrent";
import { processDownloading } from "./processor";
import { sendDiscordNotification } from "./discord";
import { getAutoDownload } from "./settings";
import { getStoredCoverage, scanCoverage } from "./coverage";

export async function pollRss(): Promise<number> {
  logger.info("Starting RSS poll cycle");

  let newEpisodes;
  try {
    newEpisodes = await fetchNewEpisodes(isGuidSeen);
  } catch (err) {
    logger.error("RSS poll failed", { error: (err as Error).message });
    return 0;
  }

  const autoDownload = getAutoDownload();

  for (const rssEp of newEpisodes) {
    try {
      logger.info("Processing new RSS entry", { crc32: rssEp.crc32, title: rssEp.title });

      // Honor the extended-cut preference: when an episode has both a standard
      // and an extended cut, only download the preferred variant. This prevents
      // a standard re-release from replacing an extended cut already on disk.
      if (!(await isPreferredRelease(rssEp.crc32))) {
        logger.info("Skipping non-preferred cut", { crc32: rssEp.crc32, title: rssEp.title });
        markGuidSeen(rssEp.guid);
        continue;
      }

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
        status: autoDownload ? "pending" : "available",
        torrent_hash: null,
        magnet_uri: rssEp.magnet,
        error_message: null,
        rss_guid: rssEp.guid,
        changelog: rssEp.changelog,
      });

      markGuidSeen(rssEp.guid);

      if (autoDownload) {
        const qbit = getQbitClient();
        const torrentHash = await qbit.addMagnet(rssEp.magnet);
        updateEpisodeStatus(rssEp.crc32, "downloading", { torrent_hash: torrentHash });
        logger.info("Episode queued for download", {
          crc32: rssEp.crc32,
          arc: ep.arcTitle,
          episode: ep.episodeNum,
          torrentHash,
        });
      } else {
        logger.info("New release available — awaiting manual download", {
          crc32: rssEp.crc32,
          arc: ep.arcTitle,
          episode: ep.episodeNum,
        });
      }

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

  return newEpisodes.length;
}

export async function dispatchPending(): Promise<void> {
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

export async function runCycle(): Promise<void> {
  const newCount = await pollRss();
  await dispatchPending();
  await processDownloading();

  // If new RSS items appeared and the user has run a coverage scan before,
  // refresh the stored report so hasMagnet stays accurate without manual
  // re-scanning. Only fires when the RSS actually changed — no extra I/O
  // on quiet poll cycles.
  if (newCount > 0 && getStoredCoverage()) {
    try {
      await scanCoverage();
      logger.info("Coverage report refreshed after RSS update");
    } catch (err) {
      logger.warn("Coverage refresh after RSS update failed", { error: (err as Error).message });
    }
  }
}
