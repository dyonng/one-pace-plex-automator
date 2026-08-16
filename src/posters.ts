import { logger } from "./logger";
import { getKv, setKv } from "./db";
import { getSettingValue, getPosterSetId } from "./settings";
import { getShowAndSeasonKeys, listPosterTargets, uploadPoster } from "./plex";
import { POSTER_SETS, getPosterSet, posterSetUrl, type PosterSet } from "./poster-sets";

// Per (target, set) record of the art we last uploaded, so unchanged images are
// skipped via conditional requests. Keyed "<target>|<setId>".
const APPLIED_KEY = "posters_applied";
// Which set we believe Plex currently has *selected* per target, so changing the
// preference re-uploads that set's art (a fresh upload becomes the selection).
const SELECTED_KEY = "posters_selected";
const SEEDED_KEY = "posters_seeded";

type AppliedEntry = { url: string; etag?: string };
type AppliedMap = Record<string, AppliedEntry | string>; // string = legacy format

export interface PosterSyncResult {
  applied: number;
  skipped: number;
  missing: number;
  failed: number;
}

// A brand-new season (e.g. the first special creating Season 0) doesn't exist in
// Plex the instant its file lands — the library scan that creates it is
// asynchronous. Poll a few times before giving up so new seasons reliably get art.
const SEASON_LOOKUP_ATTEMPTS = 4;
const SEASON_LOOKUP_DELAY_MS = 5000;

const cacheKey = (target: string, setId: string): string => `${target}|${setId}`;

function loadJson<T>(key: string, fallback: T): T {
  const raw = getKv(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function getAppliedEntry(map: AppliedMap, key: string): AppliedEntry | null {
  const v = map[key];
  if (!v) return null;
  return typeof v === "string" ? { url: v } : v;
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
 * Uploads every set's art for one target so Plex's poster picker lists them all,
 * finishing with the preferred set — an upload becomes the selected poster, so
 * going last is what makes it stick (no reliance on a separate select call).
 */
async function applyTarget(
  target: string,
  ratingKey: string,
  hasPoster: boolean,
  preferred: PosterSet,
  base: string,
  applied: AppliedMap,
  selected: Record<string, string>,
  result: PosterSyncResult
): Promise<void> {
  // Preferred last. Re-upload it when it isn't the set Plex currently shows,
  // even if the bytes are unchanged, so the selection moves.
  const ordered = [...POSTER_SETS.filter((s) => s.id !== preferred.id), preferred];
  const mustReselect = selected[target] !== preferred.id;

  for (const set of ordered) {
    const url = posterSetUrl(set, target, base);
    if (!url) continue; // this set has no art for this target

    const key = cacheKey(target, set.id);
    const entry = getAppliedEntry(applied, key);
    const isPreferred = set.id === preferred.id;
    // Trust a stored ETag only while Plex actually shows art here, and never for
    // the preferred set when the selection still has to change.
    const useEtag = hasPoster && !(isPreferred && mustReselect) ? entry?.etag : undefined;

    try {
      const fetched = await fetchImageConditional(url, useEtag);
      if (fetched === "not-modified") {
        applied[key] = { url, etag: useEtag };
        result.skipped++;
        continue;
      }
      if (fetched === null) {
        result.missing++;
        logger.debug("Set has no poster for target", { set: set.id, target, url });
        continue;
      }
      await uploadPoster(ratingKey, fetched.img);
      applied[key] = { url, etag: fetched.etag ?? undefined };
      result.applied++;
      if (isPreferred) selected[target] = set.id;
    } catch (err) {
      result.failed++;
      logger.warn("Failed to apply poster", { set: set.id, target, error: (err as Error).message });
    }
  }
}

/**
 * Applies posters from every set to the show and all seasons, leaving the
 * preferred set selected. ETag-conditional, so unchanged art costs a 304.
 */
export async function syncPosters(): Promise<PosterSyncResult> {
  const base = getSettingValue("POSTER_REPO_RAW_BASE");
  const preferred = getPosterSet(getPosterSetId());
  const applied = loadJson<AppliedMap>(APPLIED_KEY, {});
  const selected = loadJson<Record<string, string>>(SELECTED_KEY, {});
  const result: PosterSyncResult = { applied: 0, skipped: 0, missing: 0, failed: 0 };

  for (const { key, ratingKey, hasPoster } of await listPosterTargets()) {
    if (!hasPoster && getAppliedEntry(applied, cacheKey(key, preferred.id))) {
      logger.info("Poster recorded as applied but missing in Plex — re-applying", { target: key });
    }
    await applyTarget(key, ratingKey, hasPoster, preferred, base, applied, selected, result);
  }

  setKv(APPLIED_KEY, JSON.stringify(applied));
  setKv(SELECTED_KEY, JSON.stringify(selected));
  logger.info("Poster sync complete", { ...result, set: preferred.id });
  return result;
}

/**
 * Re-applies everything from scratch, ignoring stored ETags — the escape hatch
 * for when our bookkeeping and Plex disagree in a way the self-heal can't see.
 */
export async function resyncPosters(): Promise<PosterSyncResult> {
  setKv(APPLIED_KEY, "{}");
  setKv(SELECTED_KEY, "{}");
  logger.info("Poster state cleared — re-applying all posters");
  return syncPosters();
}

/**
 * Applies art for one season, called after an ingest so a brand-new season gets
 * posters automatically. Uploads every set for that season, preferred last.
 */
export async function ensureSeasonPoster(
  part: number,
  opts: { attempts?: number; delayMs?: number } = {}
): Promise<void> {
  const attempts = opts.attempts ?? SEASON_LOOKUP_ATTEMPTS;
  const delayMs = opts.delayMs ?? SEASON_LOOKUP_DELAY_MS;
  const target = String(part);
  const base = getSettingValue("POSTER_REPO_RAW_BASE");
  const preferred = getPosterSet(getPosterSetId());
  const applied = loadJson<AppliedMap>(APPLIED_KEY, {});
  const selected = loadJson<Record<string, string>>(SELECTED_KEY, {});

  if (selected[target] === preferred.id && getAppliedEntry(applied, cacheKey(target, preferred.id))) {
    return; // already applied with the current preference
  }

  try {
    // Poll for the season: when this ingest created it (e.g. the first special
    // making Season 0), Plex's scan may not have materialized it yet.
    let ratingKey: string | undefined;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const { seasonMap } = await getShowAndSeasonKeys();
      ratingKey = seasonMap.get(part);
      if (ratingKey) break;
      if (attempt < attempts) {
        logger.debug("Season not in Plex yet — retrying poster shortly", { part, attempt });
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    if (!ratingKey) {
      logger.warn("Season not in Plex yet — poster deferred to the next poster sync", { part });
      return;
    }

    const result: PosterSyncResult = { applied: 0, skipped: 0, missing: 0, failed: 0 };
    await applyTarget(target, ratingKey, false, preferred, base, applied, selected, result);
    setKv(APPLIED_KEY, JSON.stringify(applied));
    setKv(SELECTED_KEY, JSON.stringify(selected));
    logger.info("Applied posters for new season", { part, ...result });
  } catch (err) {
    logger.warn("Failed to auto-apply season poster", { part, error: (err as Error).message });
  }
}

/**
 * First-run seed: marks the preferred set's posters as already-applied WITHOUT
 * uploading, so art set manually before install is preserved.
 */
export async function seedPostersOnFirstRun(): Promise<void> {
  if (getKv(SEEDED_KEY) === "1") return;
  const base = getSettingValue("POSTER_REPO_RAW_BASE");
  const preferred = getPosterSet(getPosterSetId());
  try {
    const applied = loadJson<AppliedMap>(APPLIED_KEY, {});
    const selected = loadJson<Record<string, string>>(SELECTED_KEY, {});
    let count = 0;
    for (const { key } of await listPosterTargets()) {
      const url = posterSetUrl(preferred, key, base);
      if (!url) continue;
      applied[cacheKey(key, preferred.id)] = { url };
      selected[key] = preferred.id;
      count++;
    }
    setKv(APPLIED_KEY, JSON.stringify(applied));
    setKv(SELECTED_KEY, JSON.stringify(selected));
    setKv(SEEDED_KEY, "1");
    logger.info("First run: seeded existing posters as applied (kept manual art)", { count });
  } catch (err) {
    logger.warn("First-run poster seed failed; will retry next boot", { error: (err as Error).message });
  }
}
