import { logger } from "./logger";
import { getShowRoles, clearShowCast, getShowAndSeasonKeys } from "./plex";

// One Pace is a fan edit with no TMDB/TVDB listing, so Plex has no cast for it.
// Syncing cast from the original series was removed: the Plex edit API can only
// add bare actor-name tags to an agent-less show (no characters, no photos, no
// person-linking), and those duplicate name tags collide with the original
// series' real cast. Only the cleanup below remains — to undo a cast sync run
// before the feature was removed.

export interface CastResetResult {
  cleared: number;   // roles present before the clear
  remaining: number; // roles still on the show after the clear (should be 0)
}

/**
 * Removes the (bare/duplicate) actors from the One Pace show and unlocks the
 * field — the undo for a cast sync that left blank actors. Only touches the One
 * Pace show; recovering the source series (Fix Match, Clean Bundles, Optimize
 * Database) is a deliberate, Plex-side action. Never throws. Reads back to
 * confirm the removal actually took (Plex 200s even for params it ignores).
 */
export async function resetCast(): Promise<CastResetResult> {
  let cleared = 0;
  let remaining = 0;
  try {
    const { showKey } = await getShowAndSeasonKeys();
    cleared = await clearShowCast(showKey);
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
