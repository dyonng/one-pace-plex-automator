import { getConfig } from "./config";
import { getGoogleSheetsApiKey } from "./settings";
import { canonicalizeArcTitle } from "./arc-titles";
import { logger } from "./logger";

// ladyisatis' One Pace metadata sheet — the dataset maintainer's working source,
// usually ahead of the published data.min.json. Two tabs:
//   "Episodes": arc_title | arc_part (= episode number within the arc) | title_en | description_en
//   "Arcs":     saga_title | part (= arc/season number) | title_en | description_en
// We use it to fill episode/arc titles and descriptions into Plex for releases
// the dataset doesn't list yet.

const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h — changes rarely

export interface EpisodeText {
  arcTitle: string;
  episodeNum: number;
  title: string;
  description: string;
}

export interface ArcText {
  part: number;
  saga: string;
  title: string;
  description: string;
}

interface TextIndex {
  loadedAt: number;
  episodes: Map<string, EpisodeText>; // key = `${canonicalizeArcTitle(arc)}-${epNum}`
  arcs: Map<string, ArcText>;         // key = canonicalizeArcTitle(arcTitle)
}

let _index: TextIndex | null = null;
let _loading: Promise<TextIndex | null> | null = null;

const epKey = (arcTitle: string, episodeNum: number): string =>
  `${canonicalizeArcTitle(arcTitle)}-${episodeNum}`;

/** True when an API key is configured; the integration is a no-op otherwise. */
export function isDescriptionsEnabled(): boolean {
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

const colFinder = (header: string[]) => (name: string): number =>
  header.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase());

function parseEpisodes(rows: string[][]): EpisodeText[] {
  if (rows.length < 2) return [];
  const col = colFinder(rows[0].map((h) => (h ?? "").trim()));
  const cArc = col("arc_title");
  const cEp = col("arc_part"); // sheet's column name; values are episode numbers
  const cTitle = col("title_en");
  const cDesc = col("description_en");
  if (cArc === -1 || cEp === -1) return [];

  const out: EpisodeText[] = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const arcTitle = (row[cArc] ?? "").trim();
    const epRaw = (row[cEp] ?? "").trim();
    if (!arcTitle || !/^\d+$/.test(epRaw)) continue;
    out.push({
      arcTitle,
      episodeNum: parseInt(epRaw, 10),
      title: cTitle !== -1 ? (row[cTitle] ?? "").trim() : "",
      description: cDesc !== -1 ? (row[cDesc] ?? "").trim() : "",
    });
  }
  return out;
}

function parseArcs(rows: string[][]): ArcText[] {
  if (rows.length < 2) return [];
  const col = colFinder(rows[0].map((h) => (h ?? "").trim()));
  const cSaga = col("saga_title");
  const cPart = col("part");
  const cTitle = col("title_en");
  const cDesc = col("description_en");
  if (cTitle === -1 || cPart === -1) return [];

  const out: ArcText[] = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const title = (row[cTitle] ?? "").trim();
    const partRaw = (row[cPart] ?? "").trim();
    if (!title || !/^\d+$/.test(partRaw)) continue;
    out.push({
      part: parseInt(partRaw, 10),
      saga: cSaga !== -1 ? (row[cSaga] ?? "").trim() : "",
      title,
      description: cDesc !== -1 ? (row[cDesc] ?? "").trim() : "",
    });
  }
  return out;
}

async function buildIndex(): Promise<TextIndex | null> {
  const key = getGoogleSheetsApiKey().trim();
  if (!key) return null;
  const sheetId = getConfig().ONEPACE_METADATA_SHEET_ID;

  logger.info("Fetching One Pace metadata sheet", { sheetId });
  const ranges = ["Episodes!A1:D2000", "Arcs!A1:D200"]
    .map((r) => `ranges=${encodeURIComponent(r)}`)
    .join("&");
  const url = `${SHEETS_API}/${sheetId}/values:batchGet?key=${key}&${ranges}`;
  const data = (await getJson(url)) as { valueRanges?: { values?: string[][] }[] };
  const [epRange, arcRange] = data.valueRanges ?? [];

  const episodes = new Map<string, EpisodeText>();
  for (const ep of parseEpisodes(epRange?.values ?? [])) {
    episodes.set(epKey(ep.arcTitle, ep.episodeNum), ep);
  }
  const arcs = new Map<string, ArcText>();
  for (const arc of parseArcs(arcRange?.values ?? [])) {
    arcs.set(canonicalizeArcTitle(arc.title), arc);
  }

  logger.info("One Pace metadata sheet loaded", { episodes: episodes.size, arcs: arcs.size });
  return { loadedAt: Date.now(), episodes, arcs };
}

async function getIndex(): Promise<TextIndex | null> {
  if (!isDescriptionsEnabled()) return null;
  if (_index && Date.now() - _index.loadedAt < CACHE_TTL_MS) return _index;
  if (_loading) return _loading;

  _loading = (async () => {
    try {
      const built = await buildIndex();
      if (built) _index = built;
      return _index;
    } catch (err) {
      logger.warn("One Pace metadata sheet load failed", { error: (err as Error).message });
      return _index; // fall back to stale data if present
    } finally {
      _loading = null;
    }
  })();
  return _loading;
}

/** Forces a re-fetch of the sheet on the next lookup. */
export function clearDescriptionsCache(): void {
  _index = null;
}

/** Eagerly warms the descriptions cache. Use after clearing caches so the fetch
 *  result is visible in logs immediately rather than on the next lazy lookup. */
export async function prefetchDescriptions(): Promise<void> {
  await getIndex();
}

/**
 * Episode title + description for a (arc, episode), or null when the sheet is
 * disabled, unreachable, or the episode is absent. Arc spelling variants
 * (Arabasta/Alabasta, Whiskey/Whisky Peak) match either way.
 */
export async function lookupEpisodeText(
  arcTitle: string,
  episodeNum: number
): Promise<EpisodeText | null> {
  const index = await getIndex();
  if (!index) return null;
  return index.episodes.get(epKey(arcTitle, episodeNum)) ?? null;
}

/** Arc part/title/saga/description for an arc title, or null if not found. */
export async function lookupArcText(arcTitle: string): Promise<ArcText | null> {
  const index = await getIndex();
  if (!index) return null;
  return index.arcs.get(canonicalizeArcTitle(arcTitle)) ?? null;
}
