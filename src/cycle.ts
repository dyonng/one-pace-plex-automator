import { logger } from "./logger";
import { isGuidSeen, markGuidSeen, upsertEpisode, updateEpisodeStatus, getEpisodesByStatus, getEpisodeByCrc32, setDownloadVia, setEpisodeOriginalFilename, type EpisodeRecord } from "./db";
import { fetchNewEpisodes, toIsoDate, RssEpisode } from "./rss";
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
import { processDownloading, requeueRetryableFailures, newerFileAlreadyOnDisk } from "./processor";
import { findExistingEpisodeFile } from "./fileops";
import { sendDiscordNotification } from "./discord";
import { getAutoDownload, getPreferExtended, getArcFilter, getDownloadSource } from "./settings";
import * as pixeldrainDownloads from "./pixeldrain-downloads";
import { isArcIncluded } from "./arc-filter";
import { getStoredCoverage, scanCoverage } from "./coverage";

// Sentinel episode number for a whole-arc batch download. Real episodes start at
// 1, so this can't collide; the actual episodes are identified from the files in
// the downloaded folder once it completes.
const BATCH_EPISODE = 0;

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

  // Placement runs for every item before anything is queued. One episode can
  // appear in a single batch more than once — One Pace lists a re-release
  // alongside the release it supersedes — and the two take different branches
  // (the new hash isn't catalogued yet, the old one is). Queueing as we went
  // meant downloading both and letting the import guard throw one away, which is
  // correct but pays full price for the loser.
  const provisional: PlacedItem[] = [];
  const resolved: Array<{ rssEp: RssEpisode; ep: ResolvedEpisode }> = [];

  for (const rssEp of newEpisodes) {
    if (rssEp.crc32 === null) {
      const placement = await placeProvisional(rssEp);
      if (placement) provisional.push({ rssEp, placement });
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
        const placement = await placeProvisional(rssEp);
        if (placement) provisional.push({ rssEp, placement });
        continue;
      }

      // A filtered-out arc isn't tracked, so don't queue its releases either.
      if (!isArcIncluded(getArcFilter(), ep.arcPart, ep.arcTitle)) {
        logger.info("Skipping release from a filtered-out arc", {
          crc32: rssEp.crc32, arc: ep.arcTitle, part: ep.arcPart,
        });
        markGuidSeen(rssEp.guid);
        continue;
      }

      resolved.push({ rssEp, ep });
    } catch (err) {
      logger.error("Failed to process RSS entry", {
        crc32: rssEp.crc32,
        error: (err as Error).message,
      });
    }
  }

  // One release per episode wins. An entry the catalog can't place came from a
  // release that landed after the dataset was generated, so it is the newer of
  // the two — the same rule the coverage report and the import guard use.
  const supersededBy = new Map<string, string>();
  for (const { rssEp, placement } of provisional) {
    supersededBy.set(`${placement.arcPart}-${placement.epNum}`, rssEp.title);
  }

  for (const { rssEp, ep } of resolved) {
    try {
      const slot = `${ep.arcPart}-${ep.episodeNum}`;
      const newerInBatch = supersededBy.get(slot);
      if (newerInBatch) {
        logger.info("Skipping superseded release — a newer one for this episode is in the same batch", {
          crc32: rssEp.crc32, arc: ep.arcTitle, episode: ep.episodeNum, supersededBy: newerInBatch,
        });
        markGuidSeen(rssEp.guid);
        continue;
      }

      const skip = await reasonToSkipQueueing(rssEp.crc32!, ep.arcTitle, ep.arcPart, ep.episodeNum);
      if (skip) {
        logger.info("Skipping release — nothing to download", {
          crc32: rssEp.crc32, arc: ep.arcTitle, episode: ep.episodeNum, reason: skip,
        });
        markGuidSeen(rssEp.guid);
        continue;
      }

      upsertEpisode({
        crc32: rssEp.crc32!,
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
        published_at: toIsoDate(rssEp.pubDate),
        pixeldrain_id: rssEp.pixeldrainId,
      });

      markGuidSeen(rssEp.guid);

      if (autoDownload) {
        const qbit = getQbitClient();
        const torrentHash = await qbit.addMagnet(rssEp.magnet);
        updateEpisodeStatus(rssEp.crc32!, "downloading", { torrent_hash: torrentHash });
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
        crc32: rssEp.crc32!,
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
/**
 * Why this release shouldn't be queued at all, or null to go ahead. Both checks
 * used to happen only *after* a gigabyte had been transferred: the import guard
 * would refuse the file and the work was wasted.
 */
async function reasonToSkipQueueing(
  crc32: string,
  arcTitle: string,
  arcPart: number,
  episodeNum: number
): Promise<string | null> {
  const existing = getEpisodeByCrc32(crc32.toUpperCase());
  if (existing?.status === "done" && findExistingEpisodeFile(arcTitle, arcPart, episodeNum)) {
    return "this exact release is already in the library";
  }

  const newer = await newerFileAlreadyOnDisk(arcTitle, arcPart, episodeNum, crc32);
  if (newer) return `a newer file is already in the library (${newer})`;

  return null;
}

export interface Placement {
  arcIndex: number;
  arcPart: number;
  arcTitle: string;
  epNum: number;
  extended: boolean;
}

export interface PlacedItem {
  rssEp: RssEpisode;
  placement: Placement;
}

// An item with no resolvable CRC32 may still have a real one — it arrived via the
// unresolvable-CRC fallback rather than having no hash at all. Giving up on those
// must not mark the GUID seen: the dataset will very likely publish the hash
// soon, so the entry has to stay eligible for a proper resolve on a later poll.
const retriesLater = (rssEp: RssEpisode): boolean => rssEp.crc32 !== null;

/**
 * Works out which season/episode slot an item belongs to from its title alone,
 * for releases the catalog can't place by CRC32. Returns null when it can't be
 * placed (the reason is logged, and the GUID is marked seen only when there is
 * no point retrying).
 */
async function placeProvisional(rssEp: RssEpisode): Promise<Placement | null> {
  // Known specials whose title is not an arc name (e.g. "One Piece Fan Letter
  // 01") are pinned straight to their catalogued slot; everything else goes
  // through the normal title parse + arc lookup.
  const alias = await resolveAliasedRelease(rssEp.title);
  if (alias) {
    logger.info("Recognized special release", {
      title: rssEp.title,
      as: `${alias.label} S${String(alias.arcPart).padStart(2, "0")}E${String(alias.epNum).padStart(2, "0")}`,
    });
    return alias;
  }

  const parsed = parseReleaseTitle(rssEp.title);
  if (!parsed) {
    // No trailing episode number — but One Pace distributes most arcs as a
    // single whole-arc torrent ("[One Pace][1-7] Romance Dawn [1080p]", a folder
    // with no CRC32 anywhere). Those titles are just the arc name, so resolve
    // them as a batch instead of dropping the release.
    const batchArc = await resolveArcByTitle(rssEp.title);
    if (batchArc) {
      logger.info("Recognized whole-arc batch release", {
        title: rssEp.title, arc: batchArc.arcTitle, part: batchArc.arcPart,
      });
      return { ...batchArc, epNum: BATCH_EPISODE, extended: false };
    }
    logger.warn("Provisional download skipped — can't parse arc/episode from title", {
      title: rssEp.title, willRetry: retriesLater(rssEp),
    });
    if (!retriesLater(rssEp)) markGuidSeen(rssEp.guid);
    return null;
  }

  const arc = await resolveArcByTitle(parsed.arcTitle);
  if (!arc) {
    logger.warn("Provisional download skipped — arc not in dataset", {
      title: rssEp.title, arcTitle: parsed.arcTitle, willRetry: retriesLater(rssEp),
    });
    if (!retriesLater(rssEp)) markGuidSeen(rssEp.guid);
    return null;
  }
  return { ...arc, epNum: parsed.epNum, extended: parsed.extended };
}

async function processProvisional(items: PlacedItem[], autoDownload: boolean): Promise<void> {
  const preferExtended = getPreferExtended();

  interface Candidate {
    rssEp: RssEpisode;
    arcIndex: number;
    arcPart: number;
    arcTitle: string;
    epNum: number;
    extended: boolean;
  }
  const groups = new Map<string, Candidate[]>();

  for (const { rssEp, placement } of items) {
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
        published_at: toIsoDate(rssEp.pubDate),
        pixeldrain_id: rssEp.pixeldrainId,
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

/**
 * Routes one pending episode to Pixeldrain when that's both preferred and
 * currently possible. Returns true when the episode was dispatched that way;
 * false means "use the torrent", and the reason is logged.
 */
async function tryPixeldrainDispatch(ep: EpisodeRecord): Promise<boolean> {
  if (getDownloadSource() !== "pixeldrain") return false;
  if (!ep.pixeldrain_id) return false;

  const eligible = await pixeldrainDownloads.checkEligible(ep);
  if (!eligible.ok) {
    logger.info("Using the torrent instead of Pixeldrain", { crc32: ep.crc32, reason: eligible.reason });
    setDownloadVia(ep.crc32, "torrent");
    return false;
  }

  // The Pixeldrain filename is authoritative and carries the CRC32, so the rest
  // of the pipeline identifies the file exactly as it would a torrent's.
  setDownloadVia(ep.crc32, "pixeldrain");
  updateEpisodeStatus(ep.crc32, "downloading");
  setEpisodeOriginalFilename(ep.crc32, eligible.filename);
  logger.info("Dispatched to Pixeldrain", {
    crc32: ep.crc32, file: eligible.filename, sizeMb: Math.round(eligible.size / 1024 ** 2),
  });
  return true;
}

export async function dispatchPending(): Promise<void> {
  const pending = getEpisodesByStatus("pending");
  if (pending.length === 0) return;

  const qbit = getQbitClient();
  logger.info(`Dispatching ${pending.length} pending episode(s) to qBittorrent`);

  for (const ep of pending) {
    try {
      // Prefer the direct download when the release offers one and Pixeldrain is
      // actually able to serve it right now. It's a different failure domain
      // from BitTorrent — no peers, no port-forward, no VPN dependency — so the
      // two cover each other rather than sharing a single point of failure.
      if (await tryPixeldrainDispatch(ep)) continue;

      // A retried episode usually still has its torrent in qBittorrent — the
      // previous attempt downloaded it and failed somewhere after, so cleanup
      // never ran. Re-adding it is both wasteful and refused (409 on qBit 5.x),
      // which used to leave the episode stuck in "pending" forever. Reattach to
      // the existing torrent instead; it may already be complete, in which case
      // the next sweep imports it without downloading a byte.
      if (ep.torrent_hash && (await qbit.getTorrent(ep.torrent_hash))) {
        updateEpisodeStatus(ep.crc32, "downloading");
        logger.info("Reattached to existing torrent", { crc32: ep.crc32, torrentHash: ep.torrent_hash });
        continue;
      }

      if (!ep.magnet_uri) {
        logger.warn("Pending episode has no stored magnet URI, skipping", { crc32: ep.crc32 });
        continue;
      }

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
  // Give environmental failures a chance to recover on their own before the
  // dispatch pass, so a recovered episode is re-queued in the same cycle.
  await requeueRetryableFailures();
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
