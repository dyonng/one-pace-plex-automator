import { getConfig } from "./config";
import { logger } from "./logger";
import { getPreferExtended, getPreferArabasta } from "./settings";
import { canonicalizeArcTitle } from "./arc-titles";
import { lookupSheetEpisode, lookupSheetEpisodeByCrc32, listSheetEpisodes, getArcResolution } from "./onepace-sheet";
import { lookupEpisodeText } from "./onepace-descriptions";

export { canonicalizeArcTitle };

/**
 * The dataset spells arc 14 "Alabasta"; some users prefer "Arabasta". When the
 * preference is on, apply that spelling wherever an arc title is surfaced
 * (coverage, filenames, Plex). Saga is already "Arabasta" in the dataset.
 */
function displayArcTitle(raw: string): string {
  if (getPreferArabasta() && raw) return raw.replace(/Alabasta/g, "Arabasta");
  return raw;
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
  if (!ep) return resolveFromSheet(key, resolution);
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
 * Resolves a CRC32 the dataset doesn't list via the episode guide sheet (which
 * is often updated first). The arc must exist in the dataset — only the episode
 * itself may be new. Titles/descriptions come from the dataset's descriptions
 * when present, else ladyisatis' metadata sheet. Throws when the hash is unknown
 * to both sources, preserving the original error contract.
 */
async function resolveFromSheet(key: string, resolution: string): Promise<ResolvedEpisode> {
  const sheetEp = await lookupSheetEpisodeByCrc32(key);
  const arcEntry = sheetEp ? findArcByTitle(sheetEp.arcTitle) : null;
  if (!sheetEp || !arcEntry) throw new Error(`CRC32 ${key} not found in metadata dataset`);

  const epNum = sheetEp.episodeNum;
  const desc = _descByKey!.get(epKey(arcEntry.arc.part, epNum));
  const text = desc ? null : await lookupEpisodeText(arcEntry.arc.title, epNum);
  return {
    crc32: key,
    arcIndex: arcEntry.index,
    arcTitle: displayArcTitle(arcEntry.arc.title),
    arcSaga: arcEntry.arc.saga,
    arcPart: arcEntry.arc.part,
    arcDescription: arcEntry.arc.description,
    episodeNum: epNum,
    episodeTitle: desc?.title ?? text?.title ?? "",
    episodeDescription: desc?.description ?? text?.description ?? "",
    chapters: sheetEp.chapters.replace(/^Ch\.\s*/i, ""),
    originalEpisodes: sheetEp.animeEpisodes.replace(/^Ep\.\s*/i, ""),
    released: sheetEp.releaseDate,
    resolution,
    extended: key === sheetEp.extendedCrc32,
  };
}

// ── Sheet union ───────────────────────────────────────────────────────────────
// The official episode guide (Google Sheet) often lists a release's CRC32s
// before data.min.json is regenerated. Lookups below treat the sheet as an
// additive source: the dataset always wins when it knows an episode; the sheet
// only fills in episodes the dataset doesn't have yet. Everything degrades to
// dataset-only behavior when no Sheets API key is configured.

interface EpisodeVariants {
  standard: string;
  extended: string;
}

/** Dataset arc matching a (possibly differently spelled) external arc title. */
function findArcByTitle(arcTitle: string): { arc: DataJsonArc; index: number } | null {
  if (!_data) return null;
  const wanted = canonicalizeArcTitle(arcTitle);
  const idx = _data.arcs.en.findIndex((a) => canonicalizeArcTitle(a.title) === wanted);
  return idx === -1 ? null : { arc: _data.arcs.en[idx], index: idx };
}

/** Standard/extended CRC32s for an episode: dataset first, sheet as fallback. */
async function getVariants(arcPart: number, episodeNum: number): Promise<EpisodeVariants | null> {
  const v = _variantByKey!.get(epKey(arcPart, episodeNum));
  if (v) return v;
  const arcEntry = _arcByPart!.get(arcPart);
  if (!arcEntry) return null;
  const sheetEp = await lookupSheetEpisode(arcEntry.arc.title, episodeNum);
  if (!sheetEp) return null;
  return { standard: sheetEp.standardCrc32 ?? "", extended: sheetEp.extendedCrc32 ?? "" };
}

/**
 * The preferred CRC32 for an episode: the extended cut when one exists and the
 * "prefer extended" setting is on, otherwise the standard cut. Returns null if
 * the episode is unknown to both the dataset and the sheet.
 */
export async function getCanonicalCrc32(arcPart: number, episodeNum: number): Promise<string | null> {
  await _getData();
  const v = await getVariants(arcPart, episodeNum);
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
  if (ep) {
    const preferred = await getCanonicalCrc32(ep.arc, Number(ep.episode));
    return !preferred || preferred === key;
  }
  // Not in the dataset — the sheet may already know which cut this hash is.
  const sheetEp = await lookupSheetEpisodeByCrc32(key);
  if (!sheetEp) return true;
  const preferred =
    getPreferExtended() && sheetEp.extendedCrc32
      ? sheetEp.extendedCrc32
      : sheetEp.standardCrc32 ?? sheetEp.extendedCrc32;
  return !preferred || preferred === key;
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

  await _getData();
  const arcEntry = findArcByTitle(parsed.arcTitle);
  if (!arcEntry) {
    logger.warn("Arc not found in metadata", { arcTitle: parsed.arcTitle });
    return null;
  }

  // Match the cut named by the title — a standard release must never be keyed
  // to the extended cut's CRC32 (or vice versa). If the named cut isn't known
  // yet, return null so the provisional flow recovers the hash from the file.
  const v = await getVariants(arcEntry.arc.part, parsed.epNum);
  const crc = parsed.extended ? v?.extended : v?.standard;
  if (!crc) {
    logger.warn("Episode not found in metadata", {
      arcTitle: parsed.arcTitle,
      epNum: parsed.epNum,
      extended: parsed.extended,
    });
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
  const entry = findArcByTitle(arcTitle);
  if (!entry) return null;
  return {
    arcIndex: entry.index,
    arcPart: entry.arc.part,
    arcTitle: displayArcTitle(entry.arc.title),
    arcSaga: entry.arc.saga,
    arcDescription: entry.arc.description,
    arcReleased: earliestArcRelease(entry.arc, data),
  };
}

export interface ArcSummary {
  arcIndex: number;
  arcPart: number;
  arcTitle: string;
  arcSaga: string;
  arcDescription: string;
  arcReleased: string; // earliest episode air date in the arc ("YYYY-MM-DD"), "" if unknown
}

// The season's air date = the earliest release among its episodes. Dates are
// stored ISO-ish, so a plain string compare orders them chronologically.
function earliestArcRelease(arc: DataJsonArc, data: DataJson): string {
  let earliest = "";
  for (const ve of arc.episodes) {
    const crc = (ve.standard || ve.extended || "").toUpperCase();
    const rel = (data.episodes[crc]?.released ?? "").trim();
    if (rel && (earliest === "" || rel < earliest)) earliest = rel;
  }
  return earliest;
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
      arcReleased: earliestArcRelease(a, data),
    }));
}

export async function getAllEpisodes(): Promise<EpisodeSummary[]> {
  const data = await _getData();
  const preferExtended = getPreferExtended();
  const cacheKey = `${preferExtended}|${getPreferArabasta()}`;

  if (!_episodesCache || _episodesCache.pref !== cacheKey) {
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
  }

  // Union in episodes the sheet knows but the dataset doesn't yet (the guide is
  // often updated first). Appended fresh on every call — the sheet refreshes on
  // its own TTL, so these mustn't be frozen into the dataset-keyed cache above.
  const merged = [..._episodesCache.list];
  for (const sheetEp of await listSheetEpisodes()) {
    const arcEntry = findArcByTitle(sheetEp.arcTitle);
    if (!arcEntry || arcEntry.arc.part <= 0) continue;
    if (_variantByKey!.has(epKey(arcEntry.arc.part, sheetEp.episodeNum))) continue; // dataset wins

    const isExtended = Boolean(preferExtended && sheetEp.extendedCrc32);
    const crc = isExtended ? sheetEp.extendedCrc32! : sheetEp.standardCrc32 ?? sheetEp.extendedCrc32;
    if (!crc) continue;

    const desc = _descByKey!.get(epKey(arcEntry.arc.part, sheetEp.episodeNum));
    const text = desc ? null : await lookupEpisodeText(arcEntry.arc.title, sheetEp.episodeNum);
    merged.push({
      crc32: crc,
      arcIndex: arcEntry.index,
      arcTitle: displayArcTitle(arcEntry.arc.title),
      arcSaga: arcEntry.arc.saga,
      arcPart: arcEntry.arc.part,
      arcDescription: arcEntry.arc.description,
      episodeNum: sheetEp.episodeNum,
      episodeTitle: desc?.title ?? text?.title ?? "",
      episodeDescription: desc?.description ?? text?.description ?? "",
      chapters: sheetEp.chapters.replace(/^Ch\.\s*/i, ""),
      originalEpisodes: sheetEp.animeEpisodes.replace(/^Ep\.\s*/i, ""),
      released: sheetEp.releaseDate,
      resolution: (await getArcResolution(arcEntry.arc.title)) ?? "1080p",
      extended: crc === sheetEp.extendedCrc32,
      seasonEpisodeId: `s${String(arcEntry.arc.part).padStart(2, "0")}e${String(sheetEp.episodeNum).padStart(2, "0")}`,
    });
  }

  return merged;
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

/** The resolution tag in a filename (e.g. "1080p"), or null when absent. */
export function parseResolutionFromFilename(filename: string): string | null {
  const match = filename.match(/\[(\d{3,4}p)\]/i);
  return match ? match[1] : null;
}

export function extractResolutionFromFilename(filename: string): string {
  return parseResolutionFromFilename(filename) ?? "1080p";
}
