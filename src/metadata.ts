import { getConfig } from "./config";
import { logger } from "./logger";

interface DataJsonArc {
  part: number;
  saga: string;
  title: string;
  originaltitle: string;
  description: string;
  poster: string;
}

interface DataJsonEpisode {
  arc: number; // index into arcs[]
  episode: number;
  title: string;
  originaltitle: string;
  description: string;
  chapters: string;
  episodes: string;
  released: string;
  hashes: { crc32: string; blake2: string };
}

interface DataJson {
  arcs: DataJsonArc[];
  episodes: Record<string, DataJsonEpisode>; // key = CRC32 uppercase hex
}

export interface ResolvedEpisode {
  crc32: string;
  arcIndex: number;
  arcTitle: string;
  arcSaga: string;
  arcPart: number;
  arcDescription: string;
  episodeNum: number;
  episodeTitle: string;
  episodeDescription: string;
  chapters: string;
  originalEpisodes: string;
  released: string;
  resolution: string;
}

let _data: DataJson | null = null;
let _etag: string | null = null;
let _episodesCache: EpisodeSummary[] | null = null;

export async function getData(): Promise<{ arcs: number; episodes: number }> {
  const d = await _getData();
  return { arcs: d.arcs.length, episodes: Object.keys(d.episodes).length };
}

async function _getData(): Promise<DataJson> {
  if (_data) return _data;
  await refreshMetadata();
  if (!_data) throw new Error("Metadata dataset unavailable");
  return _data;
}

/**
 * Conditional GET of data.min.json. Uses the stored ETag so an unchanged dataset
 * costs a 304 with no body. Returns true if the cache was updated. One Pace bumps
 * an episode's CRC32 on re-release, so this must run before resolving new feed
 * items or the new CRC32 won't be found.
 */
export async function refreshMetadata(): Promise<boolean> {
  const url = `${getConfig().METADATA_REPO_RAW_BASE}/data.min.json`;
  const headers: Record<string, string> = {};
  if (_etag) headers["If-None-Match"] = _etag;

  const resp = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });

  if (resp.status === 304) {
    logger.debug("Metadata unchanged (304)");
    return false;
  }
  if (!resp.ok) throw new Error(`Metadata fetch failed: HTTP ${resp.status}`);

  _etag = resp.headers.get("etag");
  _data = (await resp.json()) as DataJson;
  _episodesCache = null; // invalidate derived cache on new data
  logger.info("Metadata dataset loaded", {
    arcs: _data.arcs.length,
    episodes: Object.keys(_data.episodes).length,
  });
  return true;
}

/** True once the dataset has been successfully loaded into memory at least once. */
export function isMetadataLoaded(): boolean {
  return _data !== null;
}

export function clearMetadataCache(): void {
  _data = null;
  _etag = null;
  _episodesCache = null;
  logger.debug("Metadata cache cleared");
}

export async function resolveEpisodeByCrc32(
  crc32: string,
  resolution = "1080p"
): Promise<ResolvedEpisode> {
  const data = await _getData();
  const key = crc32.toUpperCase();
  const ep = data.episodes[key];
  if (!ep) throw new Error(`CRC32 ${key} not found in metadata dataset`);
  const arc = data.arcs[ep.arc];
  if (!arc) throw new Error(`Arc index ${ep.arc} not found in metadata dataset`);
  return {
    crc32: key,
    arcIndex: ep.arc,
    arcTitle: arc.title,
    arcSaga: arc.saga,
    arcPart: arc.part,
    arcDescription: arc.description,
    episodeNum: ep.episode,
    episodeTitle: ep.title,
    episodeDescription: ep.description,
    chapters: ep.chapters,
    originalEpisodes: ep.episodes,
    released: ep.released,
    resolution,
  };
}

/**
 * Parses an RSS title like "Little Garden 05" into {arcTitle, epNum}.
 * Last whitespace-separated token that is purely numeric is the episode number.
 */
function parseRssTitle(title: string): { arcTitle: string; epNum: number } | null {
  const parts = title.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1];
  const epNum = parseInt(last, 10);
  if (isNaN(epNum) || !/^\d+$/.test(last)) return null;
  return { arcTitle: parts.slice(0, -1).join(" "), epNum };
}

export async function lookupCrc32ByTitle(rssTitle: string): Promise<string | null> {
  const parsed = parseRssTitle(rssTitle);
  if (!parsed) return null;

  const data = await _getData();
  const arcIndex = data.arcs.findIndex(
    (a) => a.title.toLowerCase() === parsed.arcTitle.toLowerCase()
  );
  if (arcIndex === -1) {
    logger.warn("Arc not found in metadata", { arcTitle: parsed.arcTitle });
    return null;
  }

  for (const [crc32, ep] of Object.entries(data.episodes)) {
    if (ep.arc === arcIndex && ep.episode === parsed.epNum) {
      return crc32.toUpperCase();
    }
  }

  logger.warn("Episode not found in metadata", { arcTitle: parsed.arcTitle, epNum: parsed.epNum });
  return null;
}

export interface ArcSummary {
  arcIndex: number;
  arcPart: number;
  arcTitle: string;
  arcSaga: string;
  arcDescription: string;
}

export interface EpisodeSummary extends ResolvedEpisode {
  seasonEpisodeId: string; // e.g. "s01e03"
}

export async function getAllArcs(): Promise<ArcSummary[]> {
  const data = await _getData();
  return data.arcs
    .filter((a) => a.part > 0)
    .map((a, i) => ({
      arcIndex: i,
      arcPart: a.part,
      arcTitle: a.title,
      arcSaga: a.saga,
      arcDescription: a.description,
    }));
}

export async function getAllEpisodes(): Promise<EpisodeSummary[]> {
  if (_episodesCache) return _episodesCache;

  const data = await _getData();

  // The dataset is keyed by CRC32 and retains release *history*: a re-released
  // episode keeps its old CRC entry alongside the new one (same arc+episode,
  // different `released` date). Collapse to one canonical entry per
  // (arcPart, episodeNum) — the newest `released` wins — so consumers see the
  // current release only. `released` is "YYYY-MM-DD", so a string compare
  // orders it; a missing date sorts oldest.
  const canonical = new Map<string, EpisodeSummary>();

  for (const [crc32, ep] of Object.entries(data.episodes)) {
    if (ep.arc === 0) continue; // skip specials
    const arc = data.arcs[ep.arc];
    if (!arc) continue;

    const season = String(arc.part).padStart(2, "0");
    const episode = String(ep.episode).padStart(2, "0");
    const key = `${arc.part}-${ep.episode}`;

    const existing = canonical.get(key);
    if (existing && (existing.released ?? "") >= (ep.released ?? "")) continue;

    canonical.set(key, {
      crc32: crc32.toUpperCase(),
      arcIndex: ep.arc,
      arcTitle: arc.title,
      arcSaga: arc.saga,
      arcPart: arc.part,
      arcDescription: arc.description,
      episodeNum: ep.episode,
      episodeTitle: ep.title,
      episodeDescription: ep.description,
      chapters: ep.chapters,
      originalEpisodes: ep.episodes,
      released: ep.released,
      resolution: "1080p",
      seasonEpisodeId: `s${season}e${episode}`,
    });
  }

  _episodesCache = [...canonical.values()];
  return _episodesCache;
}

export function buildPlexFilename(
  arcTitle: string,
  arcPart: number,
  episodeNum: number,
  resolution: string,
  crc32: string,
  ext: string
): string {
  const s = String(arcPart).padStart(2, "0");
  const e = String(episodeNum).padStart(2, "0");
  return `One Pace - ${arcTitle} - S${s}E${e} [${resolution}][${crc32.toUpperCase()}]${ext}`;
}

export function extractCrc32FromFilename(filename: string): string | null {
  // Last bracketed 8-char hex string before the extension: [BE634289]
  const match = filename.match(/\[([0-9A-Fa-f]{8})\](?:\.\w+)?$/);
  return match ? match[1].toUpperCase() : null;
}

export function extractResolutionFromFilename(filename: string): string {
  const match = filename.match(/\[(\d{3,4}p)\]/i);
  return match ? match[1] : "1080p";
}
