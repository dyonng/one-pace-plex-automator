import { logger } from "./logger";
import { getConfig } from "./config";
import { getSyncCast, getCastSourceShow } from "./settings";
import {
  resolveShowRatingKeyByName,
  getShowRoles,
  setShowCast,
  clearShowCast,
  getShowAndSeasonKeys,
} from "./plex";

export interface CastSyncResult {
  applied: number;        // roles we attempted to write
  verified: number;       // roles Plex actually has after the write (read-back)
  source: string | null;  // source show name when found, else null
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
  if (!getSyncCast()) return { applied: 0, verified: 0, source: null };
  const sourceName = getCastSourceShow();

  try {
    const sourceKey = await resolveShowRatingKeyByName(sourceName);
    logger.info("Cast sync: resolved source show", { source: sourceName, sourceKey });
    if (!sourceKey) {
      logger.info("Cast sync: source show not found in library — skipping", { source: sourceName });
      return { applied: 0, verified: 0, source: null };
    }

    const allRoles = await getShowRoles(sourceKey);
    const roles = allRoles.slice(0, getConfig().CAST_LIMIT);
    logger.info("Cast sync: read source cast", {
      source: sourceName,
      totalOnSource: allRoles.length,
      taking: roles.length,
      sample: roles.slice(0, 5).map((r) => `${r.tag}${r.role ? ` — ${r.role}` : ""}`),
    });
    if (roles.length === 0) {
      logger.info("Cast sync: source show has no cast listed — skipping", { source: sourceName });
      return { applied: 0, verified: 0, source: sourceName };
    }

    const { showKey } = await getShowAndSeasonKeys();
    logger.info("Cast sync: target One Pace show", { showKey });
    await setShowCast(showKey, roles);

    // Plex 200s even for params it ignores, so read the cast back to confirm the
    // write actually took. verified << applied ⇒ wrong edit-param format.
    const after = await getShowRoles(showKey);
    const verified = after.length;
    logger.info("Cast sync: read back target cast", {
      verified,
      sample: after.slice(0, 5).map((r) => `${r.tag}${r.role ? ` — ${r.role}` : ""}`),
    });
    if (verified === 0) {
      logger.warn("Cast sync: wrote roles but Plex shows none — edit params may be wrong for this Plex", {
        source: sourceName, applied: roles.length,
      });
    } else {
      logger.info("Cast sync complete", { source: sourceName, applied: roles.length, verified });
    }
    return { applied: roles.length, verified, source: sourceName };
  } catch (err) {
    logger.warn("Cast sync failed", { source: sourceName, error: (err as Error).message });
    return { applied: 0, verified: 0, source: sourceName };
  }
}

export interface CastResetResult {
  cleared: number;   // roles present before the clear
  remaining: number; // roles still on the show after the clear (should be 0)
}

/**
 * Undo a cast sync: remove the (bare/duplicate) actors from the One Pace show and
 * unlock the field. Only touches the One Pace show — recovering the source series
 * (Fix Match, Clean Bundles, Optimize Database) is a deliberate, Plex-side action,
 * NOT a heavy force-refresh triggered here. Never throws.
 */
export async function resetCast(): Promise<CastResetResult> {
  let cleared = 0;
  let remaining = 0;
  try {
    const { showKey } = await getShowAndSeasonKeys();
    cleared = await clearShowCast(showKey);
    // Read back — Plex 200s even when it ignores a param, so confirm the actors
    // are actually gone (remaining > 0 ⇒ the removal form is wrong for this Plex).
    remaining = (await getShowRoles(showKey)).length;
    if (remaining > 0) {
      logger.warn("Cast reset: cast still present after clear — removal form may be wrong", {
        cleared, remaining,
      });
    } else {
      logger.info("Cast reset: cleared One Pace cast", { cleared });
    }
  } catch (err) {
    logger.warn("Cast reset: clearing One Pace cast failed", { error: (err as Error).message });
  }
  return { cleared, remaining };
}
