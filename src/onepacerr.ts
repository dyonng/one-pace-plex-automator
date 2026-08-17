import { logger } from "./logger";
import { getConfig } from "./config";
import { getUseOnepacerr } from "./settings";

/**
 * Optional third metadata source: the community API behind eltharynd/OnePacerr.
 * It scrapes the same One Pace RSS feed and Google Sheets we do, but server-side
 * and continuously — so it often knows a release before the ladyisatis dataset
 * regenerates, and needs no Google API key.
 *
 * Strictly a gap-filler: it is consulted only after our own sources come up
 * empty, and every failure is swallowed so the service never depends on it.
 */

interface OnepacerrFile {
  CRC32?: string;
  hash?: string;
  magnetURI?: string;
  duration?: number;
  variant?: string;
}

interface OnepacerrEpisode {
  arc: number;
  episode: number;
  title?: string;
  description?: string;
  mangaChapters?: string;
  animeEpisodes?: string;
  released?: string;
  files?: Record<string, OnepacerrFile>;
}

interface OnepacerrArc {
  arc: number;
  saga?: string;
  title?: string;
  description?: string;
  episodes?: OnepacerrEpisode[];
}

interface OnepacerrMetadata {
  lastUpdate?: string;
  arcs?: OnepacerrArc[];
}

/** One release of one episode, flattened and keyed by CRC32. */
export interface OnepacerrRelease {
  crc32: string;
  arcPart: number;
  arcTitle: string;
  arcSaga: string;
  arcDescription: string;
  episodeNum: number;
  episodeTitle: string;
  episodeDescription: string;
  chapters: string;
  originalEpisodes: string;
  released: string;   // YYYY-MM-DD ("" when absent)
  extended: boolean;
  magnetURI: string;
}

const TTL_MS = 6 * 60 * 60 * 1000;

let _byCrc: Map<string, OnepacerrRelease> | null = null;
let _fetchedAt = 0;

// Their "released" is a full ISO timestamp; Plex wants a plain date.
const isoDay = (raw: string | undefined): string => (raw ?? "").slice(0, 10);

export function isOnepacerrEnabled(): boolean {
  return getUseOnepacerr();
}

function buildIndex(data: OnepacerrMetadata): Map<string, OnepacerrRelease> {
  const map = new Map<string, OnepacerrRelease>();
  for (const arc of data.arcs ?? []) {
    for (const ep of arc.episodes ?? []) {
      for (const [variant, file] of Object.entries(ep.files ?? {})) {
        const crc = (file?.CRC32 ?? "").toUpperCase();
        if (!crc) continue;
        // "archived" entries are superseded releases; still worth indexing so an
        // older file on disk resolves, but they must not claim to be extended.
        map.set(crc, {
          crc32: crc,
          arcPart: arc.arc,
          arcTitle: arc.title ?? "",
          arcSaga: arc.saga ?? "",
          arcDescription: arc.description ?? "",
          episodeNum: ep.episode,
          episodeTitle: ep.title ?? "",
          episodeDescription: ep.description ?? "",
          chapters: ep.mangaChapters ?? "",
          originalEpisodes: ep.animeEpisodes ?? "",
          released: isoDay(ep.released),
          extended: variant === "extended" || file?.variant === "extended",
          magnetURI: file?.magnetURI ?? "",
        });
      }
    }
  }
  return map;
}

/** Loads + caches the API's full metadata. Returns null when disabled or unreachable. */
async function getIndex(): Promise<Map<string, OnepacerrRelease> | null> {
  if (!isOnepacerrEnabled()) return null;
  if (_byCrc && Date.now() - _fetchedAt < TTL_MS) return _byCrc;

  const url = `${getConfig().ONEPACERR_BASE_URL.replace(/\/+$/, "")}/metadata`;
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const index = buildIndex((await resp.json()) as OnepacerrMetadata);
    _byCrc = index;
    _fetchedAt = Date.now();
    logger.info("OnePacerr metadata loaded", { releases: index.size, url });
    return index;
  } catch (err) {
    // Never fatal — this source is a bonus, not a dependency. Keep any stale
    // index rather than dropping to nothing.
    logger.debug("OnePacerr metadata unavailable", { url, error: (err as Error).message });
    return _byCrc;
  }
}

export async function lookupOnepacerrByCrc32(crc32: string): Promise<OnepacerrRelease | null> {
  const index = await getIndex();
  return index?.get(crc32.toUpperCase()) ?? null;
}

/** A magnet for a CRC32 the RSS feed no longer carries, or null. */
export async function lookupOnepacerrMagnet(crc32: string): Promise<string | null> {
  const rel = await lookupOnepacerrByCrc32(crc32);
  return rel?.magnetURI || null;
}

export function clearOnepacerrCache(): void {
  _byCrc = null;
  _fetchedAt = 0;
}

/** Eagerly warm the cache so success/failure is visible in the logs now. */
export async function prefetchOnepacerr(): Promise<void> {
  if (!isOnepacerrEnabled()) return;
  await getIndex();
}
