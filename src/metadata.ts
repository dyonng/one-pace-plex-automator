import { getConfig } from "./config";
import { logger } from "./logger";
import { getPreferExtended, getPreferArabasta } from "./settings";

/**
 * The dataset spells arc 14 "Alabasta"; some users prefer "Arabasta". When the
 * preference is on, apply that spelling wherever an arc title is surfaced
 * (coverage, filenames, Plex). Saga is already "Arabasta" in the dataset.
 */
function displayArcTitle(raw: string): string {
  if (getPreferArabasta() && raw) return raw.replace(/Alabasta/g, "Arabasta");
  return raw;
}

// Arc titles that have multiple accepted spellings in the wild. Each set maps to
// a single canonical form so a lookup matches regardless of which spelling the
// RSS title (or the official sheet) uses. The dataset spells these "Alabasta"
// and "Whisky Peak"; users/feeds sometimes write "Arabasta"/"Whiskey Peak".
const ARC_TITLE_ALIASES: Record<string, string> = {
  arabasta: "alabasta",
  "whiskey peak": "whisky peak",
};

/**
 * Normalizes an arc title for matching: lowercased, whitespace-collapsed, with
 * known spelling variants folded to a single canonical form. Use this whenever
 * comparing arc titles from external sources (RSS, the Google Sheet) so the two
 * accepted spellings are treated interchangeably.
 */
export function canonicalizeArcTitle(raw: string): string {
  const t = (raw ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  return ARC_TITLE_ALIASES[t] ?? t;
}

// ── Richer v2 metadata schema (metadata/data.min.json) ───────────────────────
// arcs.en[]            — one entry per arc; episodes[] maps each episode to its
//                        standard + (optional) extended CRC32.
// descriptions.en[]    — per-episode title/description, keyed by (arc part, episode).
// episodes{CRC32}      — per-release technical metadata; retains release history.

interface DataJsonArcEpisode {
  episode: string;   // zero-padded string, e.g. "02"
  standard: string;  // CRC32 of the standard cut
  extended: string;  // CRC32 of the extended cut, or "" if none
}

interface DataJsonArc {
  part: number;
  saga: string;
  title: string;
  originaltitle: string;
  shortcode: string;
  mkvcode: string;
  description: string;
  episodes: DataJsonArcEpisode[];
}

interface DataJsonEpisodeFile {
  id: number;
  name: string;
  size: string;
  hash: string;
  index: number;
}

interface DataJsonEpisode {
  arc: number;        // arc PART (matches DataJsonArc.part)
  episode: number;
  manga_chapters: string;
  anime_episodes: string;
  released: string;
  duration: number;
  extended: boolean;
  hashes: { crc32: string; blake2s: string };
  file?: DataJsonEpisodeFile;
}

interface DataJsonDescription {
  arc: number;        // arc PART
  episode: number;
  title: string;
  originaltitle: string;
  description: string;
}

interface DataJson {
  arcs: { en: DataJsonArc[] };
  descriptions: { en: DataJsonDescription[] };
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
  extended: boolean; // true when this CRC32 is the extended cut
}

let _data: DataJson | null = null;
let _etag: string | null = null;

// Derived lookup indexes, rebuilt whenever _data is (re)loaded.
let _arcByPart: Map<number, { arc: DataJsonArc; index: number }> | null = null;
let _descByKey: Map<string, DataJsonDescription> | null = null;
let _variantByKey: Map<string, { standard: string; extended: string }> | null = null;
// getAllEpisodes() output, cached per preference combination (cleared on reload).
let _episodesCache: { pref: string; list: EpisodeSummary[] } | null = null;

const epKey = (arcPart: number, episodeNum: number): string => `${arcPart}-${episodeNum}`;

function buildIndexes(d: DataJson): void {
  _arcByPart = new Map();
  d.arcs.en.forEach((arc, index) => _arcByPart!.set(arc.part, { arc, index }));

  _descByKey = new Map();
  for (const desc of d.descriptions.en) {
    _descByKey.set(epKey(desc.arc, Number(desc.episode)), desc);
  }

  _variantByKey = new Map();
  for (const arc of d.arcs.en) {
    for (const ve of arc.episodes) {
      _variantByKey.set(epKey(arc.part, Number(ve.episode)), {
        standard: (ve.standard ?? "").toUpperCase(),
        extended: (ve.extended ?? "").toUpperCase(),
      });
    }
  }

  _episodesCache = null;
}

export async function getData(): Promise<{ arcs: number; episodes: number }> {
  const d = await _getData();
  return { arcs: d.arcs.en.length, episodes: Object.keys(d.episodes).length };
}

async function _getData(): Promise<DataJson> {
  if (_data) return _data;
  await refreshMetadata();
  if (!_data) throw new Error("Metadata dataset unavailable");
  return _data;
}

/**
 * Conditional GET of metadata/data.min.json. Uses the stored ETag so an
 * unchanged dataset costs a 304 with no body. Returns true if the cache was
 * updated. One Pace bumps an episode's CRC32 on re-release, so this must run
 * before resolving new feed items or the new CRC32 won't be found.
 */
export async function refreshMetadata(): Promise<boolean> {
  const url = `${getConfig().METADATA_REPO_RAW_BASE}/metadata/data.min.json`;
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
  buildIndexes(_data);
  logger.info("Metadata dataset loaded", {
    arcs: _data.arcs.en.length,
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
  _arcByPart = null;
  _descByKey = null;
  _variantByKey = null;
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
  const arcEntry = _arcByPart!.get(ep.arc);
  if (!arcEntry) throw new Error(`Arc part ${ep.arc} not found in metadata dataset`);
  const epNum = Number(ep.episode);
  const desc = _descByKey!.get(epKey(ep.arc, epNum));
  return {
    crc32: key,
    arcIndex: arcEntry.index,
    arcTitle: displayArcTitle(arcEntry.arc.title),
    arcSaga: arcEntry.arc.saga,
    arcPart: arcEntry.arc.part,
    arcDescription: arcEntry.arc.description,
    episodeNum: epNum,
    episodeTitle: desc?.title ?? "",
    episodeDescription: desc?.description ?? "",
    chapters: ep.manga_chapters ?? "",
    originalEpisodes: ep.anime_episodes ?? "",
    released: ep.released ?? "",
    resolution,
    extended: Boolean(ep.extended),
  };
}

/**
 * The preferred CRC32 for an episode: the extended cut when one exists and the
 * "prefer extended" setting is on, otherwise the standard cut. Returns null if
 * the episode is unknown.
 */
export async function getCanonicalCrc32(arcPart: number, episodeNum: number): Promise<string | null> {
  await _getData();
  const v = _variantByKey!.get(epKey(arcPart, episodeNum));
  if (!v) return null;
  if (getPreferExtended() && v.extended) return v.extended;
  return v.standard || v.extended || null;
}

/**
 * True if a CRC32 is the variant we'd want to keep for its episode, per the
 * current preference. Used by the RSS poll to skip downloading the non-preferred
 * cut (e.g. a standard re-release when the extended cut is preferred). Unknown
 * CRC32s return true (fail-open — never silently drop a genuinely new release).
 */
export async function isPreferredRelease(crc32: string): Promise<boolean> {
  const data = await _getData();
  const key = crc32.toUpperCase();
  const ep = data.episodes[key];
  if (!ep) return true;
  const preferred = await getCanonicalCrc32(ep.arc, Number(ep.episode));
  if (!preferred) return true;
  return preferred === key;
}

/**
 * Parses an RSS title like "Little Garden 05" or "Egghead 21 Extended Cut" into
 * {arcTitle, epNum, extended}. A trailing "Extended Cut"/"Extended" marker is
 * stripped and flagged; the last remaining whitespace-separated token must be
 * purely numeric and is taken as the episode number.
 */
// Provisional episode records use a synthetic key (no real CRC32 known yet).
// The processor recognizes these by prefix and recovers the real CRC32 from the
// downloaded file, then re-keys the record.
const PROVISIONAL_PREFIX = "PROV-";

export function provisionalKey(arcPart: number, episodeNum: number, extended: boolean): string {
  return `${PROVISIONAL_PREFIX}${arcPart}-${episodeNum}${extended ? "-E" : ""}`;
}

export function isProvisionalKey(crc32: string): boolean {
  return crc32.startsWith(PROVISIONAL_PREFIX);
}

export function parseReleaseTitle(
  title: string
): { arcTitle: string; epNum: number; extended: boolean } | null {
  let t = title.trim();
  let extended = false;
  const extMatch = t.match(/\s+extended(?:\s+cut)?\s*$/i);
  if (extMatch) {
    extended = true;
    t = t.slice(0, extMatch.index).trim();
  }
  const parts = t.split(/\s+/);
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1];
  const epNum = parseInt(last, 10);
  if (isNaN(epNum) || !/^\d+$/.test(last)) return null;
  return { arcTitle: parts.slice(0, -1).join(" "), epNum, extended };
}

export async function lookupCrc32ByTitle(rssTitle: string): Promise<string | null> {
  const parsed = parseReleaseTitle(rssTitle);
  if (!parsed) return null;

  const data = await _getData();
  const wanted = canonicalizeArcTitle(parsed.arcTitle);
  const arc = data.arcs.en.find((a) => canonicalizeArcTitle(a.title) === wanted);
  if (!arc) {
    logger.warn("Arc not found in metadata", { arcTitle: parsed.arcTitle });
    return null;
  }

  const crc = await getCanonicalCrc32(arc.part, parsed.epNum);
  if (!crc) {
    logger.warn("Episode not found in metadata", { arcTitle: parsed.arcTitle, epNum: parsed.epNum });
    return null;
  }
  return crc;
}

/**
 * Resolves an arc by its title (e.g. "Egghead") to its summary, including the
 * season part number. Unlike lookupCrc32ByTitle this succeeds even when the
 * specific episode isn't catalogued yet — used to place a provisional download
 * into the right season folder before the episode appears in the dataset.
 */
export async function resolveArcByTitle(arcTitle: string): Promise<ArcSummary | null> {
  const data = await _getData();
  const wanted = canonicalizeArcTitle(arcTitle);
  const idx = data.arcs.en.findIndex((a) => canonicalizeArcTitle(a.title) === wanted);
  if (idx === -1) return null;
  const a = data.arcs.en[idx];
  return {
    arcIndex: idx,
    arcPart: a.part,
    arcTitle: displayArcTitle(a.title),
    arcSaga: a.saga,
    arcDescription: a.description,
  };
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
  return data.arcs.en
    .map((a, index) => ({ a, index }))
    .filter(({ a }) => a.part > 0)
    .map(({ a, index }) => ({
      arcIndex: index,
      arcPart: a.part,
      arcTitle: displayArcTitle(a.title),
      arcSaga: a.saga,
      arcDescription: a.description,
    }));
}

export async function getAllEpisodes(): Promise<EpisodeSummary[]> {
  const data = await _getData();
  const preferExtended = getPreferExtended();
  const cacheKey = `${preferExtended}|${getPreferArabasta()}`;
  if (_episodesCache && _episodesCache.pref === cacheKey) return _episodesCache.list;

  // The arc episode list gives the current canonical standard + extended CRC32
  // per (arc, episode). Pick the preferred variant; everything else (titles,
  // technical fields) hangs off that CRC32.
  const list: EpisodeSummary[] = [];
  for (const { arc, index } of _arcByPart!.values()) {
    if (arc.part <= 0) continue; // skip specials
    for (const ve of arc.episodes) {
      const epNum = Number(ve.episode);
      const isExtended = Boolean(preferExtended && ve.extended);
      const crc = (isExtended ? ve.extended : ve.standard || ve.extended || "").toUpperCase();
      if (!crc) continue;

      const epData = data.episodes[crc];
      const desc = _descByKey!.get(epKey(arc.part, epNum));
      const season = String(arc.part).padStart(2, "0");
      const episode = String(epNum).padStart(2, "0");

      list.push({
        crc32: crc,
        arcIndex: index,
        arcTitle: displayArcTitle(arc.title),
        arcSaga: arc.saga,
        arcPart: arc.part,
        arcDescription: arc.description,
        episodeNum: epNum,
        episodeTitle: desc?.title ?? "",
        episodeDescription: desc?.description ?? "",
        chapters: epData?.manga_chapters ?? "",
        originalEpisodes: epData?.anime_episodes ?? "",
        released: epData?.released ?? "",
        resolution: extractResolutionFromFilename(epData?.file?.name ?? ""),
        extended: Boolean(epData?.extended),
        seasonEpisodeId: `s${season}e${episode}`,
      });
    }
  }

  _episodesCache = { pref: cacheKey, list };
  return list;
}

export function buildPlexFilename(
  arcTitle: string,
  arcPart: number,
  episodeNum: number,
  resolution: string,
  crc32: string,
  ext: string,
  extended = false
): string {
  const s = String(arcPart).padStart(2, "0");
  const e = String(episodeNum).padStart(2, "0");
  const tag = extended ? "[Extended]" : "";
  return `One Pace - ${arcTitle} - S${s}E${e} [${resolution}][${crc32.toUpperCase()}]${tag}${ext}`;
}

export function extractCrc32FromFilename(filename: string): string | null {
  // The 8-char hex CRC bracket, e.g. [BE634289]. Take the last such bracket so
  // a trailing tag like [Extended] (our naming) or any suffix doesn't hide it.
  // [1080p]/[Extended] never match (not 8 hex chars).
  const matches = [...filename.matchAll(/\[([0-9A-Fa-f]{8})\]/g)];
  return matches.length ? matches[matches.length - 1][1].toUpperCase() : null;
}

export function extractResolutionFromFilename(filename: string): string {
  const match = filename.match(/\[(\d{3,4}p)\]/i);
  return match ? match[1] : "1080p";
}
