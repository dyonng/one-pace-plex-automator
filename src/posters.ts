import { logger } from "./logger";
import { getKv, setKv } from "./db";
import { getSettingValue } from "./settings";
import { getShowAndSeasonKeys, uploadPoster } from "./plex";

// Map of poster target -> { url, etag } last applied, so we can skip unchanged
// art via conditional HTTP requests and re-apply only when the image changes.
const APPLIED_KEY = "posters_applied";
const SEEDED_KEY = "posters_seeded";

type AppliedEntry = { url: string; etag?: string };
type AppliedMap = Record<string, AppliedEntry | string>; // string = legacy format

export interface PosterSyncResult {
  applied: number;
  skipped: number;
  missing: number;
  failed: number;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

function posterUrl(base: string, key: string): string {
  const b = base.replace(/\/+$/, "");
  if (key === "show") return `${b}/poster.png`;
  if (key === "0") return `${b}/season-specials-poster.png`;
  return `${b}/season${pad2(Number(key))}-poster.png`;
}

function loadApplied(): AppliedMap {
  const raw = getKv(APPLIED_KEY);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as AppliedMap;
  } catch {
    return {};
  }
}

const saveApplied = (m: AppliedMap): void => setKv(APPLIED_KEY, JSON.stringify(m));

function getAppliedEntry(map: AppliedMap, key: string): AppliedEntry | null {
  const v = map[key];
  if (!v) return null;
  return typeof v === "string" ? { url: v } : v;
}

async function listTargets(): Promise<Array<{ key: string; ratingKey: string }>> {
  const { showKey, seasonMap } = await getShowAndSeasonKeys();
  const targets = [{ key: "show", ratingKey: showKey }];
  for (const [index, ratingKey] of seasonMap) {
    targets.push({ key: String(index), ratingKey });
  }
  return targets;
}

/** Fetches a poster image using a conditional GET (If-None-Match) when an ETag
 *  is available. Returns "not-modified" on 304, null on 404, or the image + new ETag. */
async function fetchImageConditional(
  url: string,
  etag?: string
): Promise<{ img: Buffer; etag: string | null } | "not-modified" | null> {
  const headers: Record<string, string> = etag ? { "If-None-Match": etag } : {};
  const resp = await fetch(url, { signal: AbortSignal.timeout(20_000), headers });
  if (resp.status === 304) return "not-modified";
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return { img: Buffer.from(await resp.arrayBuffer()), etag: resp.headers.get("etag") };
}

/**
 * Applies posters from the fan-made repo to Plex. Uses ETag-based conditional
 * requests — posters are only re-uploaded when the remote image actually changes.
 * Already-applied posters that haven't changed are skipped without a full download.
 */
export async function syncPosters(): Promise<PosterSyncResult> {
  const base = getSettingValue("POSTER_REPO_RAW_BASE");
  const applied = loadApplied();
  const result: PosterSyncResult = { applied: 0, skipped: 0, missing: 0, failed: 0 };

  const targets = await listTargets();
  for (const { key, ratingKey } of targets) {
    const url = posterUrl(base, key);
    const entry = getAppliedEntry(applied, key);
    try {
      const fetched = await fetchImageConditional(url, entry?.etag);
      if (fetched === "not-modified") {
        applied[key] = { url, etag: entry?.etag };
        result.skipped++;
        continue;
      }
      if (fetched === null) {
        result.missing++;
        logger.debug("No poster in repo for target", { key, url });
        continue;
      }
      await uploadPoster(ratingKey, fetched.img);
      applied[key] = { url, etag: fetched.etag ?? undefined };
      result.applied++;
      logger.info("Applied poster", { target: key === "show" ? "show" : `season ${key}` });
    } catch (err) {
      result.failed++;
      logger.warn("Failed to apply poster", { key, error: (err as Error).message });
    }
  }

  saveApplied(applied);
  logger.info("Poster sync complete", { ...result });
  return result;
}

/**
 * Applies one season's poster if not already applied with the current URL.
 * Called after ingest so a brand-new season gets art automatically.
 */
export async function ensureSeasonPoster(part: number): Promise<void> {
  const key = String(part);
  const base = getSettingValue("POSTER_REPO_RAW_BASE");
  const url = posterUrl(base, key);

  const applied = loadApplied();
  if (getAppliedEntry(applied, key)?.url === url) return;

  try {
    const { seasonMap } = await getShowAndSeasonKeys();
    const ratingKey = seasonMap.get(part);
    if (!ratingKey) return;
    const fetched = await fetchImageConditional(url);
    if (!fetched || fetched === "not-modified") return;
    await uploadPoster(ratingKey, fetched.img);
    applied[key] = { url, etag: fetched.etag ?? undefined };
    saveApplied(applied);
    logger.info("Applied poster for new season", { part });
  } catch (err) {
    logger.warn("Failed to auto-apply season poster", { part, error: (err as Error).message });
  }
}

/**
 * First-run seed: marks every poster target currently in Plex as already-applied
 * WITHOUT uploading. Preserves posters the user set manually.
 */
export async function seedPostersOnFirstRun(): Promise<void> {
  if (getKv(SEEDED_KEY) === "1") return;
  const base = getSettingValue("POSTER_REPO_RAW_BASE");
  try {
    const targets = await listTargets();
    const applied = loadApplied();
    for (const { key } of targets) applied[key] = { url: posterUrl(base, key) };
    saveApplied(applied);
    setKv(SEEDED_KEY, "1");
    logger.info("First run: seeded existing posters as applied (kept manual art)", {
      count: targets.length,
    });
  } catch (err) {
    logger.warn("First-run poster seed failed; will retry next boot", { error: (err as Error).message });
  }
}
