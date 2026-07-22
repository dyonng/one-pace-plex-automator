import axios from "axios";
import { getConfig } from "./config";
import { logger } from "./logger";

import type { ArcSummary, EpisodeSummary } from "./metadata";

interface PlexMetadata {
  ratingKey: string;
  title: string;
  summary?: string;
  thumb?: string;
  index: number;
  parentIndex?: number;
  seasonEpisode?: string;
  type: string;
}

interface PlexContainer {
  MediaContainer: { Metadata: PlexMetadata[] };
}

function baseParams(): Record<string, string> {
  return { "X-Plex-Token": getConfig().PLEX_TOKEN };
}

async function plexGet<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const { PLEX_URL } = getConfig();
  const resp = await axios.get<T>(`${PLEX_URL}${path}`, {
    params: { ...baseParams(), ...params },
    headers: { Accept: "application/json" },
    timeout: 15_000,
  });
  return resp.data;
}

async function plexPut(path: string, params: Record<string, string | number> = {}): Promise<void> {
  const { PLEX_URL } = getConfig();
  await axios.put(`${PLEX_URL}${path}`, null, {
    params: { ...baseParams(), ...params },
    timeout: 15_000,
  });
}


// Resolved once at first use, reused for the lifetime of the process
let _sectionId: string | null = null;
let _showRatingKey: string | null = null;

async function resolveSectionId(): Promise<string> {
  if (_sectionId) return _sectionId;
  const { PLEX_LIBRARY_NAME } = getConfig();

  const result = await plexGet<{ MediaContainer: { Directory: Array<{ key: string; title: string }> } }>(
    "/library/sections"
  );
  const section = result.MediaContainer.Directory?.find(
    (d) => d.title.toLowerCase() === PLEX_LIBRARY_NAME.toLowerCase()
  );
  if (!section) throw new Error(`Plex library "${PLEX_LIBRARY_NAME}" not found`);
  _sectionId = section.key;
  logger.info("Resolved Plex library section", { name: PLEX_LIBRARY_NAME, id: _sectionId });
  return _sectionId;
}

async function resolveShowRatingKey(sectionId: string): Promise<string> {
  if (_showRatingKey) return _showRatingKey;

  const result = await plexGet<PlexContainer>(`/library/sections/${sectionId}/all`, { type: "2" });
  const show = result.MediaContainer.Metadata?.find(
    (m) => m.title.toLowerCase() === "one pace"
  );
  if (!show) throw new Error(`Show "One Pace" not found in Plex library`);
  _showRatingKey = show.ratingKey;
  logger.info("Resolved Plex show", { name: "One Pace", ratingKey: _showRatingKey });
  return _showRatingKey;
}

export async function resolvePlexConnection(): Promise<{ plexUrl: string; libraryName: string; showTitle: string }> {
  const sectionId = await resolveSectionId();
  await resolveShowRatingKey(sectionId);
  const { PLEX_URL, PLEX_LIBRARY_NAME } = getConfig();
  return { plexUrl: PLEX_URL, libraryName: PLEX_LIBRARY_NAME, showTitle: "One Pace" };
}

/** Resolves the show ratingKey plus a season-index → ratingKey map (index 0 = Specials). */
export async function getShowAndSeasonKeys(): Promise<{
  showKey: string;
  seasonMap: Map<number, string>;
}> {
  const sectionId = await resolveSectionId();
  const showKey = await resolveShowRatingKey(sectionId);
  const seasonMap = await buildSeasonKeyMap(showKey);
  return { showKey, seasonMap };
}

export interface CastRole {
  tag: string;     // actor name
  role: string;    // character
  tagKey?: string; // Plex person GUID (links to the person's photo + other roles)
}

/** Finds a show by title in the configured library (case-insensitive). Null if absent. */
export async function resolveShowRatingKeyByName(name: string): Promise<string | null> {
  const sectionId = await resolveSectionId();
  const result = await plexGet<PlexContainer>(`/library/sections/${sectionId}/all`, { type: "2" });
  const show = result.MediaContainer.Metadata?.find(
    (m) => m.title.toLowerCase() === name.toLowerCase()
  );
  return show?.ratingKey ?? null;
}

/** The cast (actor + character + person key) listed on a show, in billing order. */
export async function getShowRoles(ratingKey: string): Promise<CastRole[]> {
  const result = await plexGet<{
    MediaContainer: { Metadata?: Array<{ Role?: Array<{ tag?: string; role?: string; tagKey?: string }> }> };
  }>(`/library/metadata/${ratingKey}`);
  const roles = result.MediaContainer.Metadata?.[0]?.Role ?? [];
  return roles
    .filter((r) => r.tag)
    .map((r) => ({ tag: r.tag as string, role: r.role ?? "", tagKey: r.tagKey }));
}

/**
 * Removes all cast from a show and unlocks the field — the undo for a cast sync
 * that left bare/duplicate actor tags. Uses Plex's tag-removal form
 * (`actor[].tag.tag-` = comma-joined names). Returns how many were removed.
 */
export async function clearShowCast(ratingKey: string): Promise<number> {
  const current = await getShowRoles(ratingKey);
  const params: Record<string, string | number> = { type: 2, "actor.locked": 0 };
  if (current.length > 0) {
    params["actor[].tag.tag-"] = current.map((r) => r.tag).join(",");
  }
  await plexPut(`/library/metadata/${ratingKey}`, params);
  return current.length;
}

/**
 * Edit params that replace a show's cast, mirroring the reference
 * `old_scripts/sync_cast_list.py`: `actor[i].tag` = actor name, `actor[i].role`
 * = character. Locks the field so the Plex agent won't overwrite it. Pure —
 * unit-tested; the one place to adjust if a Plex build wants a different format.
 */
export function buildCastEditParams(roles: CastRole[]): Record<string, string | number> {
  // Plex's multi-value tag fields want `actor[i].tag.tag` for the tag value
  // (the old script's `actor[i].tag` is silently ignored — Plex still 200s).
  // The character goes on `actor[i].tag.role`.
  const params: Record<string, string | number> = { type: 2, "actor.locked": 1 };
  roles.forEach((r, i) => {
    params[`actor[${i}].tag.tag`] = r.tag;
    if (r.role) params[`actor[${i}].tag.role`] = r.role;
  });
  return params;
}

/** Replaces the cast on a show with the given roles (locked). Verbose — logs the
 *  exact params (first actor sample) and the HTTP status so a format mismatch is
 *  diagnosable from one run. */
export async function setShowCast(ratingKey: string, roles: CastRole[]): Promise<void> {
  const { PLEX_URL } = getConfig();
  const params = buildCastEditParams(roles);
  const sample = Object.entries(params)
    .filter(([k]) => k === "type" || k === "actor.locked" || k.startsWith("actor[0]"))
    .map(([k, v]) => `${k}=${v}`);
  logger.info("Cast edit request", {
    ratingKey,
    roles: roles.length,
    paramCount: Object.keys(params).length,
    firstActorParams: sample,
  });
  const resp = await axios.put(`${PLEX_URL}/library/metadata/${ratingKey}`, null, {
    params: { ...baseParams(), ...params },
    timeout: 20_000,
    validateStatus: () => true,
  });
  logger.info("Cast edit response", { ratingKey, status: resp.status });
}

/** Uploads a poster image (bytes) to a metadata item; Plex makes it the selected art. */
export async function uploadPoster(ratingKey: string, image: Buffer, contentType = "image/png"): Promise<void> {
  const { PLEX_URL } = getConfig();
  await axios.post(`${PLEX_URL}/library/metadata/${ratingKey}/posters`, image, {
    params: baseParams(),
    headers: { "Content-Type": contentType },
    timeout: 20_000,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });
}

/** Cheap reachability probe for health checks — hits /identity with a short timeout. */
export async function pingPlex(): Promise<void> {
  const { PLEX_URL } = getConfig();
  await axios.get(`${PLEX_URL}/identity`, {
    params: baseParams(),
    headers: { Accept: "application/json" },
    timeout: 8000,
  });
}

export async function triggerLibraryScan(): Promise<void> {
  const sectionId = await resolveSectionId();
  logger.info("Triggering Plex library scan", { sectionId });
  await plexGet(`/library/sections/${sectionId}/refresh`);
}

export async function refreshShow(): Promise<void> {
  const sectionId = await resolveSectionId();
  const showKey = await resolveShowRatingKey(sectionId);
  logger.info("Refreshing Plex show metadata", { ratingKey: showKey });
  // Refresh is a PUT (POST 404s — see refreshItem).
  await plexPut(`/library/metadata/${showKey}/refresh`);
}

// Build a map of seasonEpisodeId ("s01e03") → ratingKey for fast lookups
async function buildEpisodeKeyMap(showRatingKey: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();

  const seasonsResult = await plexGet<PlexContainer>(`/library/metadata/${showRatingKey}/children`);
  const seasons = seasonsResult.MediaContainer.Metadata ?? [];

  for (const season of seasons) {
    const epsResult = await plexGet<PlexContainer>(`/library/metadata/${season.ratingKey}/children`);
    const episodes = epsResult.MediaContainer.Metadata ?? [];
    for (const ep of episodes) {
      const s = String(season.index).padStart(2, "0");
      const e = String(ep.index).padStart(2, "0");
      map.set(`s${s}e${e}`, ep.ratingKey);
    }
  }

  return map;
}

// Build a map of season number → ratingKey
async function buildSeasonKeyMap(showRatingKey: string): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  const result = await plexGet<PlexContainer>(`/library/metadata/${showRatingKey}/children`);
  for (const season of result.MediaContainer.Metadata ?? []) {
    map.set(season.index, season.ratingKey);
  }
  return map;
}

export function buildEpisodeSummary(ep: EpisodeSummary): string {
  const parts = [ep.episodeDescription.trim()];
  if (ep.chapters) parts.push(`Manga Chapter(s): ${ep.chapters}`);
  if (ep.originalEpisodes) parts.push(`Original Anime Episode(s): ${ep.originalEpisodes}`);
  return parts.join("\n\n");
}

export function buildSeasonSummary(arc: ArcSummary): string {
  return `${arc.arcDescription}\n\nSaga: ${arc.arcSaga}`;
}

export async function updateEpisodeInPlex(
  ratingKey: string,
  ep: EpisodeSummary
): Promise<void> {
  const params: Record<string, string | number> = {
    "title.value": ep.episodeTitle,
    "title.locked": 1,
    "summary.value": buildEpisodeSummary(ep),
    "summary.locked": 1,
  };
  if (ep.released) {
    params["originallyAvailableAt.value"] = ep.released;
    params["originallyAvailableAt.locked"] = 1;
  }
  await plexPut(`/library/metadata/${ratingKey}`, params);
}

export async function updateSeasonInPlex(
  ratingKey: string,
  arc: ArcSummary
): Promise<void> {
  await plexPut(`/library/metadata/${ratingKey}`, {
    "title.value": arc.arcTitle,
    "title.locked": 1,
    "summary.value": buildSeasonSummary(arc),
    "summary.locked": 1,
  });
}

export async function syncSingleEpisode(ep: EpisodeSummary): Promise<void> {
  const sectionId = await resolveSectionId();
  const showKey = await resolveShowRatingKey(sectionId);

  const [episodeMap, seasonMap] = await Promise.all([
    buildEpisodeKeyMap(showKey),
    buildSeasonKeyMap(showKey),
  ]);

  const ratingKey = episodeMap.get(ep.seasonEpisodeId);
  if (!ratingKey) {
    logger.warn("Episode not found in Plex", { id: ep.seasonEpisodeId });
    return;
  }

  await updateEpisodeInPlex(ratingKey, ep);
  logger.info("Updated episode metadata", { id: ep.seasonEpisodeId, title: ep.episodeTitle });

  // Also update this episode's season (the full sync used to be the only thing
  // setting arc title/summary — needed when this is a new season's first episode).
  const seasonKey = seasonMap.get(ep.arcPart);
  if (seasonKey) {
    try {
      await updateSeasonInPlex(seasonKey, {
        arcIndex: ep.arcIndex,
        arcPart: ep.arcPart,
        arcTitle: ep.arcTitle,
        arcSaga: ep.arcSaga,
        arcDescription: ep.arcDescription,
      });
      logger.info("Updated season metadata", { part: ep.arcPart, title: ep.arcTitle });
    } catch (err) {
      logger.warn("Failed to update season", { part: ep.arcPart, error: (err as Error).message });
    }
  }
}

export async function syncFullLibrary(
  arcs: ArcSummary[],
  episodes: EpisodeSummary[]
): Promise<void> {
  const sectionId = await resolveSectionId();
  const showKey = await resolveShowRatingKey(sectionId);

  const [seasonMap, episodeMap] = await Promise.all([
    buildSeasonKeyMap(showKey),
    buildEpisodeKeyMap(showKey),
  ]);

  // Update seasons
  for (const arc of arcs) {
    const seasonKey = seasonMap.get(arc.arcPart);
    if (!seasonKey) continue;
    try {
      await updateSeasonInPlex(seasonKey, arc);
      logger.debug("Updated season", { part: arc.arcPart, title: arc.arcTitle });
    } catch (err) {
      logger.warn("Failed to update season", { part: arc.arcPart, error: (err as Error).message });
    }
  }

  // Update episodes
  let updated = 0;
  let skipped = 0;
  for (const ep of episodes) {
    const ratingKey = episodeMap.get(ep.seasonEpisodeId);
    if (!ratingKey) { skipped++; continue; }
    try {
      await updateEpisodeInPlex(ratingKey, ep);
      updated++;
    } catch (err) {
      logger.warn("Failed to update episode", { id: ep.seasonEpisodeId, error: (err as Error).message });
    }
  }

  await refreshShow();
  logger.info("Full library sync complete", { updated, skipped });
}

export interface PlexItemMeta {
  title: string;
  summary: string;
  hasThumb: boolean;
  thumbPath: string | null; // versioned path (…/thumb/<ts>) — changes on regen
  ratingKey: string;
}

export interface PlexMetadataSnapshot {
  seasons: Map<number, PlexItemMeta>;   // key: season index (= arc part)
  episodes: Map<string, PlexItemMeta>;  // key: "s01e03"
}

// A Plex `thumb` value pointing at a generated/uploaded image; the agent-less
// default placeholder path is not a real thumbnail.
function hasRealThumb(thumb: string | undefined): boolean {
  if (!thumb) return false;
  // Real thumbs live under /library/metadata/<key>/thumb/<ts>. Skip default
  // agent placeholders (e.g. a bare "/:/resources/...").
  return thumb.startsWith("/library/metadata/");
}

/**
 * Reads the show's current season + episode title/summary from Plex in just two
 * requests: the show's `/children` (seasons) and `/allLeaves` (every episode).
 * Feeds the metadata audit, which diffs this against the canonical dataset.
 */
export async function scanPlexMetadata(): Promise<PlexMetadataSnapshot> {
  const sectionId = await resolveSectionId();
  const showKey = await resolveShowRatingKey(sectionId);

  const [seasonsRes, leavesRes] = await Promise.all([
    plexGet<PlexContainer>(`/library/metadata/${showKey}/children`),
    plexGet<PlexContainer>(`/library/metadata/${showKey}/allLeaves`),
  ]);

  const seasons = new Map<number, PlexItemMeta>();
  for (const s of seasonsRes.MediaContainer.Metadata ?? []) {
    seasons.set(s.index, {
      title: s.title ?? "",
      summary: s.summary ?? "",
      hasThumb: hasRealThumb(s.thumb),
      thumbPath: s.thumb ?? null,
      ratingKey: s.ratingKey,
    });
  }

  const episodes = new Map<string, PlexItemMeta>();
  for (const e of leavesRes.MediaContainer.Metadata ?? []) {
    if (e.parentIndex == null || e.index == null) continue;
    const id = `s${String(e.parentIndex).padStart(2, "0")}e${String(e.index).padStart(2, "0")}`;
    episodes.set(id, {
      title: e.title ?? "",
      summary: e.summary ?? "",
      hasThumb: hasRealThumb(e.thumb),
      thumbPath: e.thumb ?? null,
      ratingKey: e.ratingKey,
    });
  }

  return { seasons, episodes };
}

// ok = 2xx with bytes; status = a non-2xx HTTP response (e.g. 404 — the thumb
// resource is genuinely gone); null status = a network error / timeout (transient).
export type ThumbFetch = { ok: true; buf: Buffer } | { ok: false; status: number | null };

/**
 * Fetches a thumbnail's bytes. `transcoded` = true asks Plex's photo transcoder
 * for a small JPEG (cheap to decode); false fetches the raw stored image. The
 * caller tries both, so an undecodable transcode can fall back to the raw image,
 * and distinguishes a genuine 404 (dangling thumb) from a transient failure.
 */
export async function fetchThumbBytes(thumbPath: string, transcoded: boolean): Promise<ThumbFetch> {
  const { PLEX_URL } = getConfig();
  try {
    const resp = transcoded
      ? await axios.get(`${PLEX_URL}/photo/:/transcode`, {
          params: { ...baseParams(), width: 96, height: 96, minSize: 1, format: "jpg", url: thumbPath },
          responseType: "arraybuffer",
          timeout: 10_000,
          validateStatus: () => true,
        })
      : await axios.get(`${PLEX_URL}${thumbPath}`, {
          params: baseParams(),
          responseType: "arraybuffer",
          timeout: 10_000,
          validateStatus: () => true,
        });
    if (resp.status >= 200 && resp.status < 300) {
      const buf = Buffer.from(resp.data);
      return buf.length > 0 ? { ok: true, buf } : { ok: false, status: resp.status };
    }
    return { ok: false, status: resp.status };
  } catch {
    return { ok: false, status: null };
  }
}

/**
 * Asks Plex to re-acquire metadata (incl. artwork) for an item. When the agent
 * has no episode still, Plex extracts a frame from the video — a best-effort way
 * to get an episode thumbnail. Fire-and-observe: the result shows up on a later
 * scan, not synchronously.
 */
export async function refreshItem(ratingKey: string): Promise<void> {
  // Refresh is a PUT (matches python-plexapi's item.refresh()); POST 404s.
  // force=1 is the web UI's "Refresh Metadata" flag — re-acquire artwork even
  // when Plex thinks nothing changed.
  await plexPut(`/library/metadata/${ratingKey}/refresh`, { force: 1 });
}

/**
 * Triggers media analysis for an item, which generates the video preview
 * (scrubber) thumbnails when the library has that setting enabled.
 */
export async function analyzeItem(ratingKey: string): Promise<void> {
  await plexPut(`/library/metadata/${ratingKey}/analyze`);
}
