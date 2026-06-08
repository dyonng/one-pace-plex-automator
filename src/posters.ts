import { logger } from "./logger";
import { getKv, setKv } from "./db";
import { getSettingValue } from "./settings";
import { getShowAndSeasonKeys, uploadPoster } from "./plex";

// Map of poster target -> the source URL last applied, so we can skip unchanged
// art and re-apply when the source (or repo base) changes. Single kv row.
const APPLIED_KEY = "posters_applied";
const SEEDED_KEY = "posters_seeded";

type AppliedMap = Record<string, string>;

export interface PosterSyncResult {
  applied: number;
  skipped: number;
  missing: number;
  failed: number;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** Builds the raw URL for a poster target. key: "show" | "0" (specials) | season part. */
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

/** Fetches an image's bytes. Returns null on 404 (no poster for that target). */
async function fetchImage(url: string): Promise<Buffer | null> {
  const resp = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return Buffer.from(await resp.arrayBuffer());
}

/** Enumerates poster targets present in Plex: the show, plus every season (0 = Specials). */
async function listTargets(): Promise<Array<{ key: string; ratingKey: string }>> {
  const { showKey, seasonMap } = await getShowAndSeasonKeys();
  const targets = [{ key: "show", ratingKey: showKey }];
  for (const [index, ratingKey] of seasonMap) {
    targets.push({ key: String(index), ratingKey });
  }
  return targets;
}

/**
 * Applies posters from the fan-made repo to Plex. Normal mode skips targets
 * already applied with the same source URL (and any seeded on first run, so it
 * never clobbers posters the user set manually). force re-uploads everything.
 */
export async function syncPosters(opts: { force?: boolean } = {}): Promise<PosterSyncResult> {
  const base = getSettingValue("POSTER_REPO_RAW_BASE");
  const applied = loadApplied();
  const result: PosterSyncResult = { applied: 0, skipped: 0, missing: 0, failed: 0 };

  const targets = await listTargets();
  for (const { key, ratingKey } of targets) {
    const url = posterUrl(base, key);
    if (!opts.force && applied[key] === url) {
      result.skipped++;
      continue;
    }
    try {
      const img = await fetchImage(url);
      if (!img) {
        result.missing++;
        logger.debug("No poster in repo for target", { key, url });
        continue;
      }
      await uploadPoster(ratingKey, img);
      applied[key] = url;
      result.applied++;
      logger.info("Applied poster", { target: key === "show" ? "show" : `season ${key}` });
    } catch (err) {
      result.failed++;
      logger.warn("Failed to apply poster", { key, error: (err as Error).message });
    }
  }

  saveApplied(applied);
  logger.info("Poster sync complete", { ...result, force: Boolean(opts.force) });
  return result;
}

/**
 * Applies one season's poster if not already applied. Called after ingest so a
 * brand-new season gets art automatically; a no-op for seasons already covered
 * (including everything seeded on first run).
 */
export async function ensureSeasonPoster(part: number): Promise<void> {
  const key = String(part);
  const base = getSettingValue("POSTER_REPO_RAW_BASE");
  const url = posterUrl(base, key);

  const applied = loadApplied();
  if (applied[key] === url) return; // already done — skip the Plex round-trip

  try {
    const { seasonMap } = await getShowAndSeasonKeys();
    const ratingKey = seasonMap.get(part);
    if (!ratingKey) return; // season not in Plex yet
    const img = await fetchImage(url);
    if (!img) return; // no poster for this season in the repo
    await uploadPoster(ratingKey, img);
    applied[key] = url;
    saveApplied(applied);
    logger.info("Applied poster for new season", { part });
  } catch (err) {
    logger.warn("Failed to auto-apply season poster", { part, error: (err as Error).message });
  }
}

/**
 * First-run seed: marks every poster target currently in Plex as already-applied
 * WITHOUT uploading. Preserves posters the user set manually — only seasons added
 * after this point get auto-posters. A force sync ignores this.
 */
export async function seedPostersOnFirstRun(): Promise<void> {
  if (getKv(SEEDED_KEY) === "1") return;
  const base = getSettingValue("POSTER_REPO_RAW_BASE");
  try {
    const targets = await listTargets();
    const applied = loadApplied();
    for (const { key } of targets) applied[key] = posterUrl(base, key);
    saveApplied(applied);
    setKv(SEEDED_KEY, "1");
    logger.info("First run: seeded existing posters as applied (kept manual art)", {
      count: targets.length,
    });
  } catch (err) {
    // Leave the flag unset so it retries next boot rather than auto-uploading.
    logger.warn("First-run poster seed failed; will retry next boot", { error: (err as Error).message });
  }
}
