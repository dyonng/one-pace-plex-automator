import { getConfig } from "./config";
import { getGoogleSheetsApiKey } from "./settings";
import { canonicalizeArcTitle } from "./metadata";
import { logger } from "./logger";

// The official One Pace episode guide is a Google Sheet with one tab per arc
// (plus an "Arc Overview" tab). Each arc tab lists every episode with its
// standard and — where one exists — extended-cut CRC32. The team often updates
// this sheet before the metadata repo's data.min.json, so it serves as an early
// source to recover a release's CRC32 when the dataset doesn't list it yet.

const OVERVIEW_TAB = "Arc Overview";
const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h — the sheet changes rarely
const HEX8 = /^[0-9A-Fa-f]{8}$/;

export interface SheetEpisode {
  arcTitle: string;       // arc tab title, as written in the sheet
  episodeNum: number;
  standardCrc32: string | null;
  extendedCrc32: string | null;
  chapters: string;
  animeEpisodes: string;
  releaseDate: string;
}

interface SheetIndex {
  loadedAt: number;
  byKey: Map<string, SheetEpisode>;    // key = `${canonicalizeArcTitle(arc)}-${epNum}`
  arcResolution: Map<string, string>;  // key = canonicalizeArcTitle(arc) → e.g. "480p"
}

let _index: SheetIndex | null = null;
let _loading: Promise<SheetIndex | null> | null = null;

const indexKey = (arcTitle: string, episodeNum: number): string =>
  `${canonicalizeArcTitle(arcTitle)}-${episodeNum}`;

/** True when an API key is configured; the integration is a no-op otherwise. */
export function isSheetEnabled(): boolean {
  return getGoogleSheetsApiKey().trim().length > 0;
}

async function getJson(url: string): Promise<unknown> {
  const resp = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Google Sheets API HTTP ${resp.status}: ${body.slice(0, 200)}`);
  }
  return resp.json();
}

/** Fetches the arc tab titles (excluding the Arc Overview summary tab). */
async function fetchArcTabTitles(sheetId: string, key: string): Promise<string[]> {
  const url = `${SHEETS_API}/${sheetId}?key=${key}&fields=sheets.properties.title`;
  const data = (await getJson(url)) as { sheets?: { properties?: { title?: string } }[] };
  return (data.sheets ?? [])
    .map((s) => s.properties?.title ?? "")
    .filter((t) => t && t !== OVERVIEW_TAB);
}

const colFinder = (header: string[]) => (name: string): number =>
  header.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase());

/** Parses one arc tab's rows into episode records. Header-driven (column order
 *  and presence vary between arcs — some have extended-cut columns, some don't). */
function parseArcTab(arcTitle: string, rows: string[][]): SheetEpisode[] {
  if (rows.length < 2) return [];
  const header = rows[0].map((h) => (h ?? "").trim());
  const col = colFinder(header);
  const cEp = col("One Pace Episode");
  const cStd = col("MKV CRC32");
  const cExt = col("MKV CRC32 (Extended)");
  const cCh = col("Chapters");
  const cAnime = col("Episodes");
  const cDate = col("Release Date");
  if (cEp === -1 || cStd === -1) {
    logger.warn("One Pace sheet: arc tab missing expected columns", { arcTitle, header });
    return [];
  }

  const out: SheetEpisode[] = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const epCell = (row[cEp] ?? "").trim();
    if (!epCell) continue;
    const numMatch = epCell.match(/(\d+)/); // arc names carry no digits → first number is the episode
    if (!numMatch) continue;
    const std = (row[cStd] ?? "").trim();
    const ext = cExt !== -1 ? (row[cExt] ?? "").trim() : "";
    const stdOk = HEX8.test(std);
    const extOk = HEX8.test(ext);
    if (!stdOk && !extOk) continue; // "To Be Released" / placeholder rows
    out.push({
      arcTitle,
      episodeNum: parseInt(numMatch[1], 10),
      standardCrc32: stdOk ? std.toUpperCase() : null,
      extendedCrc32: extOk ? ext.toUpperCase() : null,
      chapters: cCh !== -1 ? (row[cCh] ?? "").trim() : "",
      animeEpisodes: cAnime !== -1 ? (row[cAnime] ?? "").trim() : "",
      releaseDate: cDate !== -1 ? (row[cDate] ?? "").trim() : "",
    });
  }
  return out;
}

/**
 * Parses the "Arc Overview" tab into a per-arc resolution map. Arc names there
 * carry status suffixes like "(TBR)"/"(WIP)" which are stripped before matching;
 * a cell may list several resolutions (e.g. "720p,1080p") — we keep the highest.
 */
function parseArcResolution(rows: string[][]): Map<string, string> {
  const out = new Map<string, string>();
  if (rows.length < 2) return out;
  const col = colFinder(rows[0].map((h) => (h ?? "").trim()));
  const cArc = col("Arcs");
  const cRes = col("Resolution");
  if (cArc === -1 || cRes === -1) return out;

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const arcRaw = (row[cArc] ?? "").replace(/\([^)]*\)/g, "").trim(); // drop "(TBR)"/"(WIP)"
    if (!arcRaw) continue;
    const resCell = (row[cRes] ?? "").trim();
    const found = [...resCell.matchAll(/(\d{3,4})p/gi)].map((m) => parseInt(m[1], 10));
    if (found.length === 0) continue;
    out.set(canonicalizeArcTitle(arcRaw), `${Math.max(...found)}p`);
  }
  return out;
}

async function buildIndex(): Promise<SheetIndex | null> {
  const key = getGoogleSheetsApiKey().trim();
  if (!key) return null;
  const sheetId = getConfig().ONEPACE_SHEET_ID;

  const titles = await fetchArcTabTitles(sheetId, key);
  if (titles.length === 0) {
    logger.warn("One Pace sheet: no arc tabs found");
    return { loadedAt: Date.now(), byKey: new Map(), arcResolution: new Map() };
  }

  // One batchGet pulls the Arc Overview tab plus every arc tab in a single request.
  const tabs = [OVERVIEW_TAB, ...titles];
  const ranges = tabs.map((t) => `ranges=${encodeURIComponent(`'${t}'!A1:Z1000`)}`).join("&");
  const url = `${SHEETS_API}/${sheetId}/values:batchGet?key=${key}&${ranges}`;
  const data = (await getJson(url)) as { valueRanges?: { values?: string[][] }[] };
  const valueRanges = data.valueRanges ?? [];

  const arcResolution = parseArcResolution(valueRanges[0]?.values ?? []);
  const byKey = new Map<string, SheetEpisode>();
  titles.forEach((title, i) => {
    for (const ep of parseArcTab(title, valueRanges[i + 1]?.values ?? [])) {
      byKey.set(indexKey(ep.arcTitle, ep.episodeNum), ep);
    }
  });

  logger.info("One Pace sheet loaded", { arcs: titles.length, episodes: byKey.size, arcResolutions: arcResolution.size });
  return { loadedAt: Date.now(), byKey, arcResolution };
}

/** Returns the parsed sheet index, fetching (and caching) it on first use.
 *  Returns null when no API key is configured. Never throws — on error it logs
 *  and returns the stale index if available, otherwise null. */
async function getIndex(forceRefresh = false): Promise<SheetIndex | null> {
  if (!isSheetEnabled()) return null;
  if (!forceRefresh && _index && Date.now() - _index.loadedAt < CACHE_TTL_MS) return _index;
  if (_loading) return _loading;

  _loading = (async () => {
    try {
      const built = await buildIndex();
      if (built) _index = built;
      return _index;
    } catch (err) {
      logger.warn("One Pace sheet load failed", { error: (err as Error).message });
      return _index; // fall back to stale data if we have it
    } finally {
      _loading = null;
    }
  })();
  return _loading;
}

/** Forces a re-fetch of the sheet on the next lookup. */
export function clearSheetCache(): void {
  _index = null;
}

/**
 * Looks up an episode in the official sheet by arc title + episode number. Arc
 * spelling variants (Arabasta/Alabasta, Whiskey/Whisky Peak) match either way.
 * Returns null if the sheet is disabled, unreachable, or the episode is absent.
 */
export async function lookupSheetEpisode(
  arcTitle: string,
  episodeNum: number
): Promise<SheetEpisode | null> {
  const index = await getIndex();
  if (!index) return null;
  return index.byKey.get(indexKey(arcTitle, episodeNum)) ?? null;
}

/**
 * The CRC32 to use for a (arc, episode) per the extended-cut preference: the
 * extended cut when one exists and `preferExtended` is set, otherwise the
 * standard cut (falling back to whichever is present). Null if not found.
 */
export async function getSheetCrc32(
  arcTitle: string,
  episodeNum: number,
  preferExtended: boolean
): Promise<string | null> {
  const ep = await lookupSheetEpisode(arcTitle, episodeNum);
  if (!ep) return null;
  if (preferExtended && ep.extendedCrc32) return ep.extendedCrc32;
  return ep.standardCrc32 ?? ep.extendedCrc32;
}

/**
 * The resolution an arc is released in (e.g. "480p" for Loguetown), per the Arc
 * Overview tab. Used as a smarter default than a hardcoded 1080p when a release
 * filename carries no resolution tag. Null when the sheet is disabled or the arc
 * isn't listed. Arc spelling variants match either way.
 */
export async function getArcResolution(arcTitle: string): Promise<string | null> {
  const index = await getIndex();
  if (!index) return null;
  return index.arcResolution.get(canonicalizeArcTitle(arcTitle)) ?? null;
}
