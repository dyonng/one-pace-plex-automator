import { logger } from "./logger";
import { getConfig } from "./config";
import { getSyncCast, getCastSourceShow } from "./settings";
import { resolveShowRatingKeyByName, getShowRoles, setShowCast, getShowAndSeasonKeys } from "./plex";

export interface CastSyncResult {
  applied: number;       // roles written to the One Pace show
  source: string | null; // source show name when found, else null
}

/**
 * One Pace has no TMDB/TVDB listing, so it has no cast. This copies the main
 * cast (voice actors + characters) from the original series' show — which lives
 * in the same Plex library — onto the One Pace show. In Plex the show-level cast
 * is inherited by every episode in the UI, so one write covers the whole show.
 *
 * No-op (never throws) when disabled or when the source show isn't in the
 * library, so it's safe to call unconditionally from Full Plex sync.
 */
export async function syncCast(): Promise<CastSyncResult> {
  if (!getSyncCast()) return { applied: 0, source: null };
  const sourceName = getCastSourceShow();

  try {
    const sourceKey = await resolveShowRatingKeyByName(sourceName);
    if (!sourceKey) {
      logger.info("Cast sync: source show not found in library — skipping", { source: sourceName });
      return { applied: 0, source: null };
    }

    const roles = (await getShowRoles(sourceKey)).slice(0, getConfig().CAST_LIMIT);
    if (roles.length === 0) {
      logger.info("Cast sync: source show has no cast listed — skipping", { source: sourceName });
      return { applied: 0, source: sourceName };
    }

    const { showKey } = await getShowAndSeasonKeys();
    await setShowCast(showKey, roles);
    logger.info("Cast sync complete", { source: sourceName, applied: roles.length });
    return { applied: roles.length, source: sourceName };
  } catch (err) {
    logger.warn("Cast sync failed", { source: sourceName, error: (err as Error).message });
    return { applied: 0, source: sourceName };
  }
}
