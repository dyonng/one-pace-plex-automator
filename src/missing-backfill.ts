import { logger } from "./logger";
import { getEpisodeByCrc32, getEpisodesByStatus, getKv, setKv, upsertEpisode, updateEpisodeStatus } from "./db";
import { getStoredCoverage } from "./coverage";
import { canonicalizeArcTitle, parseBatchArcTitle, parseReleaseTitle, resolveEpisodeByCrc32 } from "./metadata";
import { searchTorrents, type TorrentSearchResult } from "./torrent-search";
import { getQbitClient } from "./qbittorrent";
import { prepareBatchDownload } from "./batch-fileselect";
import { sendDiscordNotification } from "./discord";
import { getAutoDownload, getAutoSearchMissing, getMissingSearchPerCycle } from "./settings";
import { toIsoDate } from "./rss";

// Targets that found nothing aren't retried for a day — otherwise every 2h
// cycle re-hammers both indexers for episodes that simply aren't posted.
const NEGATIVE_RETRY_MS = 24 * 60 * 60 * 1000;
const CURSOR_KEY = "backfill_cursor";
const ATTEMPT_PREFIX = "backfill_attempt:";

function buildQuery(arcTitle: string, episodeNum: number): string {
  return `One Pace ${arcTitle} ${String(episodeNum).padStart(2, "0")}`;
}

function matchesTarget(result: TorrentSearchResult, arcTitle: string, episodeNum: number, extended: boolean): boolean {
  const parsed = parseReleaseTitle(result.title);
  if (!parsed) return false;
  return (
    canonicalizeArcTitle(parsed.arcTitle) === canonicalizeArcTitle(arcTitle) &&
    parsed.epNum === episodeNum &&
    parsed.extended === extended
  );
}

function pickBest(results: TorrentSearchResult[], arcTitle: string, episodeNum: number, extended: boolean): TorrentSearchResult | null {
  const matching = results.filter(
    (r) => (r.magnet ?? r.torrentUrl) && matchesTarget(r, arcTitle, episodeNum, extended)
  );
  if (matching.length === 0) return null;
  return [...matching].sort((a, b) => (b.seeders ?? -1) - (a.seeders ?? -1))[0];
}

// Packs bigger than this are never worth fetching for one episode — a full
// series dump matched by accident, not an arc release.
const PACK_MAX_BYTES = 20 * 1024 ** 3;

/**
 * Arc-pack fallback for a missing episode with no single release: a pack for
 * the whole arc (e.g. "[One Pace][431-441] Post-Enies Lobby [720p]") usually
 * predates the episode's single release and still carries the file, which the
 * import flow then places as a sibling. Dead and absurdly large packs are
 * skipped — only missing (empty-slot) targets qualify, since every file the
 * pack holds for the target slot is wanted by definition.
 */
function pickPack(results: TorrentSearchResult[], arcTitle: string, extended: boolean): TorrentSearchResult | null {
  const packs = results.filter((r) => {
    if (!(r.magnet ?? r.torrentUrl)) return false;
    if ((r.seeders ?? 1) <= 0) return false;
    if (r.size != null && r.size > PACK_MAX_BYTES) return false;
    const pack = parseBatchArcTitle(r.title);
    return (
      pack !== null &&
      canonicalizeArcTitle(pack.arcTitle) === canonicalizeArcTitle(arcTitle) &&
      pack.extended === extended
    );
  });
  if (packs.length === 0) return null;
  return [...packs].sort((a, b) => (b.seeders ?? -1) - (a.seeders ?? -1))[0];
}

/**
 * Auto-searches AnimeTosho/Nyaa for episodes the library is missing (or could
 * upgrade) that the RSS feed no longer carries a magnet for. Budgeted per
 * refresh and round-robined so a large backlog drains slowly without burning
 * either indexer's rate limits. Never throws — failures are logged.
 */
export async function backfillMissing(): Promise<number> {
  if (!getAutoSearchMissing()) return 0;
  const coverage = getStoredCoverage();
  if (!coverage) return 0;

  const inFlight = new Set<string>();
  for (const st of ["pending", "downloading", "processing"] as const) {
    for (const e of getEpisodesByStatus(st)) inFlight.add(e.crc32.toUpperCase());
  }

  const now = Date.now();
  const targets = coverage.arcs
    .flatMap((a) => a.episodes)
    .filter((e) => (e.status === "missing" || e.status === "upgradeable") && !inFlight.has(e.datasetCrc32.toUpperCase()))
    .filter((e) => {
      const attempted = Number(getKv(`${ATTEMPT_PREFIX}${e.datasetCrc32.toUpperCase()}`) ?? 0);
      return !(attempted && now - attempted < NEGATIVE_RETRY_MS);
    });
  if (targets.length === 0) return 0;

  const budget = getMissingSearchPerCycle();
  const cursor = Number(getKv(CURSOR_KEY) ?? 0) || 0;
  const autoDownload = getAutoDownload();
  let queued = 0;

  for (let i = 0; i < Math.min(budget, targets.length); i++) {
    const target = targets[(cursor + i) % targets.length];
    const crc = target.datasetCrc32.toUpperCase();
    try {
      // Fast path: the RSS feed already yielded a magnet for this CRC (stored
      // by the coverage scan) — no external search needed.
      if (target.hasMagnet) {
        const stored = getKv(`magnet:${crc}`);
        const magnet = (() => {
          if (stored) {
            try {
              return (JSON.parse(stored) as { magnet?: string }).magnet ?? null;
            } catch {
              return null;
            }
          }
          return getEpisodeByCrc32(crc)?.magnet_uri ?? null;
        })();
        if (magnet && (await queueFound(crc, magnet, null, autoDownload, false))) queued++;
        else setKv(`${ATTEMPT_PREFIX}${crc}`, String(now));
        continue;
      }

      const results = await searchTorrents(buildQuery(target.arcTitle, target.episodeNum));
      const best = pickBest(results, target.arcTitle, target.episodeNum, target.extended);
      if (!best) {
        // No single release — an arc pack may still carry the file. The
        // episode-numbered query can't match a pack title, so retry arc-wide.
        let pack = target.status === "missing" ? pickPack(results, target.arcTitle, target.extended) : null;
        if (!pack && target.status === "missing") {
          const arcResults = await searchTorrents(`One Pace ${target.arcTitle}`);
          pack = pickPack([...results, ...arcResults], target.arcTitle, target.extended);
        }
        if (!pack) {
          setKv(`${ATTEMPT_PREFIX}${crc}`, String(now));
          logger.info("Backfill search found no match", {
            arc: target.arcTitle, episode: target.episodeNum, crc,
          });
          continue;
        }
        // Stamp the attempt up front: a dud pack that lacks the episode
        // self-cleans on completion, and this stops it re-downloading daily.
        setKv(`${ATTEMPT_PREFIX}${crc}`, String(now));
        const source = pack.magnet ?? pack.torrentUrl!;
        logger.info("Backfill episode found in arc pack", {
          arc: target.arcTitle, episode: target.episodeNum, crc, pack: pack.title.slice(0, 80),
        });
        if (await queueFound(crc, source, pack.publishedAt, autoDownload, true)) queued++;
        continue;
      }
      const source = best.magnet ?? best.torrentUrl!;
      if (await queueFound(crc, source, best.publishedAt, autoDownload, false)) queued++;
    } catch (err) {
      logger.warn("Backfill search failed", {
        arc: target.arcTitle, episode: target.episodeNum, error: (err as Error).message,
      });
    }
  }

  setKv(CURSOR_KEY, String((cursor + Math.min(budget, targets.length)) % targets.length));
  if (queued > 0) logger.info("Backfill queued episodes from indexers", { queued });
  return queued;
}

async function queueFound(crc: string, source: string, publishedAt: number | null, autoDownload: boolean, pack: boolean): Promise<boolean> {
  let meta;
  try {
    meta = await resolveEpisodeByCrc32(crc);
  } catch (err) {
    logger.warn("Backfill match not in catalog, skipping", { crc, error: (err as Error).message });
    return false;
  }
  upsertEpisode({
    crc32: crc,
    arc_num: meta.arcIndex,
    arc_title: meta.arcTitle,
    arc_part: meta.arcPart,
    episode_num: meta.episodeNum,
    resolution: meta.resolution,
    original_filename: "",
    final_filename: null,
    status: autoDownload ? "pending" : "available",
    torrent_hash: null,
    magnet_uri: source,
    error_message: null,
    rss_guid: "",
    changelog: [],
    extended: meta.extended,
    published_at: publishedAt ? new Date(publishedAt).toISOString().slice(0, 10) : toIsoDate(null),
    pixeldrain_id: null,
  });
  if (autoDownload) {
    // Packs only fetch the files the library still needs — the rest of the
    // arc stays deselected, so a 2GB pack can cost a single episode.
    const torrentHash = pack
      ? await prepareBatchDownload(source)
      : await getQbitClient().addMagnet(source);
    updateEpisodeStatus(crc, "downloading", { torrent_hash: torrentHash });
    logger.info("Backfill episode queued for download", {
      crc, arc: meta.arcTitle, episode: meta.episodeNum, torrentHash,
    });
  } else {
    logger.info("Backfill episode available — awaiting manual download", {
      crc, arc: meta.arcTitle, episode: meta.episodeNum,
    });
  }
  await sendDiscordNotification({
    type: "new_episode",
    crc32: crc,
    arcTitle: meta.arcTitle,
    arcPart: meta.arcPart,
    episodeNum: meta.episodeNum,
  });
  return true;
}
