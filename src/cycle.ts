import { logger } from "./logger";
import { isGuidSeen, markGuidSeen, upsertEpisode, updateEpisodeStatus, getEpisodesByStatus } from "./db";
import { fetchNewEpisodes, RssEpisode } from "./rss";
import {
  resolveEpisodeByCrc32,
  extractResolutionFromFilename,
  parseResolutionFromFilename,
  isPreferredRelease,
  parseReleaseTitle,
  resolveArcByTitle,
  resolveAliasedRelease,
  provisionalKey,
  type ResolvedEpisode,
} from "./metadata";
import { getArcResolution } from "./onepace-sheet";
import { getQbitClient } from "./qbittorrent";
import { processDownloading } from "./processor";
import { sendDiscordNotification } from "./discord";
import { getAutoDownload, getPreferExtended } from "./settings";
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

  // Items whose CRC32 couldn't be determined are handled separately, after the
  // resolved ones, so same-poll standard/extended variants can be de-duplicated.
  const provisional: RssEpisode[] = [];

  for (const rssEp of newEpisodes) {
    if (rssEp.crc32 === null) {
      provisional.push(rssEp);
      continue;
    }
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
      let ep: ResolvedEpisode;
      try {
        ep = await resolveEpisodeByCrc32(rssEp.crc32, resolution);
      } catch (err) {
        // The CRC32 isn't in the dataset or the episode guide yet — normal when a
        // release lands before either regenerates. Fall through to the
        // title-derived provisional path instead of dead-ending here; the GUID is
        // deliberately left unseen so the entry re-resolves properly once the
        // sources catch up.
        logger.info("CRC32 not resolvable yet — trying provisional path", {
          crc32: rssEp.crc32,
          title: rssEp.title,
          reason: (err as Error).message,
        });
        provisional.push(rssEp);
        continue;
      }

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
        extended: ep.extended,
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

  if (provisional.length > 0) {
    await processProvisional(provisional, autoDownload);
  }

  return newEpisodes.length;
}

/**
 * Handles RSS items with no resolvable CRC32 (release landed before the catalog
 * listed the episode). We identify the arc + episode from the title and start a
 * provisional download; the real CRC32 and metadata are recovered from the
 * downloaded file. When both a standard and an extended cut for the same episode
 * appear in one poll, only the preferred variant is downloaded so the second to
 * finish doesn't clobber the first.
 */
async function processProvisional(items: RssEpisode[], autoDownload: boolean): Promise<void> {
  const preferExtended = getPreferExtended();

  // Group parsable items by (arcPart, episode); unparsable arc/title are skipped.
  interface Candidate {
    rssEp: RssEpisode;
    arcIndex: number;
    arcPart: number;
    arcTitle: string;
    epNum: number;
    extended: boolean;
  }
  const groups = new Map<string, Candidate[]>();

  // An item that arrived here *with* a CRC32 came from the unresolvable-CRC
  // fallback, not from a missing hash. Giving up on those must not mark the GUID
  // seen: the CRC is real and the dataset/guide will very likely publish it soon,
  // so the entry has to stay eligible for a proper resolve on a later poll.
  const retriesLater = (rssEp: RssEpisode): boolean => rssEp.crc32 !== null;

  for (const rssEp of items) {
    // Known specials whose title is not an arc name (e.g. "One Piece Fan Letter
    // 01") are pinned straight to their catalogued slot; everything else goes
    // through the normal title parse + arc lookup.
    const alias = await resolveAliasedRelease(rssEp.title);
    let placement: { arcIndex: number; arcPart: number; arcTitle: string; epNum: number; extended: boolean };

    if (alias) {
      logger.info("Recognized special release", {
        title: rssEp.title,
        as: `${alias.label} S${String(alias.arcPart).padStart(2, "0")}E${String(alias.epNum).padStart(2, "0")}`,
      });
      placement = alias;
    } else {
      const parsed = parseReleaseTitle(rssEp.title);
      if (!parsed) {
        logger.warn("Provisional download skipped — can't parse arc/episode from title", {
          title: rssEp.title,
          willRetry: retriesLater(rssEp),
        });
        if (!retriesLater(rssEp)) markGuidSeen(rssEp.guid);
        continue;
      }
      const arc = await resolveArcByTitle(parsed.arcTitle);
      if (!arc) {
        logger.warn("Provisional download skipped — arc not in dataset", {
          title: rssEp.title,
          arcTitle: parsed.arcTitle,
          willRetry: retriesLater(rssEp),
        });
        if (!retriesLater(rssEp)) markGuidSeen(rssEp.guid);
        continue;
      }
      placement = { ...arc, epNum: parsed.epNum, extended: parsed.extended };
    }

    const key = `${placement.arcPart}-${placement.epNum}`;
    const candidate: Candidate = {
      rssEp,
      arcIndex: placement.arcIndex,
      arcPart: placement.arcPart,
      arcTitle: placement.arcTitle,
      epNum: placement.epNum,
      extended: placement.extended,
    };
    const group = groups.get(key);
    if (group) group.push(candidate);
    else groups.set(key, [candidate]);
  }

  for (const candidates of groups.values()) {
    // Pick the preferred cut when multiple variants are present in this poll.
    let chosen = candidates[0];
    if (candidates.length > 1) {
      const match = candidates.find((c) => c.extended === preferExtended);
      chosen = match ?? candidates.find((c) => !c.extended) ?? candidates[0];
      for (const c of candidates) {
        if (c !== chosen) {
          logger.info("Skipping non-preferred provisional cut", { title: c.rssEp.title });
          markGuidSeen(c.rssEp.guid);
        }
      }
    }

    const { rssEp, arcIndex, arcPart, arcTitle, epNum, extended } = chosen;
    try {
      const key = provisionalKey(arcPart, epNum, extended);
      // RSS titles for provisional items rarely carry a resolution tag; fall back
      // to the arc's known resolution so the record isn't mislabeled before the
      // real value is read off the downloaded file.
      const resolution =
        parseResolutionFromFilename(rssEp.filename)
        ?? (await getArcResolution(arcTitle))
        ?? "1080p";

      upsertEpisode({
        crc32: key,
        arc_num: arcIndex,
        arc_title: arcTitle,
        arc_part: arcPart,
        episode_num: epNum,
        resolution,
        original_filename: rssEp.filename,
        final_filename: null,
        status: autoDownload ? "pending" : "available",
        torrent_hash: null,
        magnet_uri: rssEp.magnet,
        error_message: null,
        rss_guid: rssEp.guid,
        changelog: rssEp.changelog,
        extended,
      });

      markGuidSeen(rssEp.guid);

      if (autoDownload) {
        const torrentHash = await getQbitClient().addMagnet(rssEp.magnet);
        updateEpisodeStatus(key, "downloading", { torrent_hash: torrentHash });
        logger.info("Provisional download started", {
          provisionalKey: key,
          arc: arcTitle,
          episode: epNum,
          extended,
          torrentHash,
        });
      } else {
        logger.info("Provisional release available — awaiting manual download", {
          provisionalKey: key,
          arc: arcTitle,
          episode: epNum,
          extended,
        });
      }

      await sendDiscordNotification({
        type: "new_episode",
        crc32: key,
        arcTitle,
        arcPart,
        episodeNum: epNum,
      });
    } catch (err) {
      logger.error("Failed to start provisional download", {
        title: rssEp.title,
        error: (err as Error).message,
      });
    }
  }
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
