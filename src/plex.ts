import axios from "axios";
import { getConfig } from "./config";
import { logger } from "./logger";

import type { ArcSummary, EpisodeSummary } from "./metadata";

interface PlexMetadata {
  ratingKey: string;
  title: string;
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

async function plexPost(path: string): Promise<void> {
  const { PLEX_URL } = getConfig();
  await axios.post(`${PLEX_URL}${path}`, null, {
    params: baseParams(),
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

export async function triggerLibraryScan(): Promise<void> {
  const sectionId = await resolveSectionId();
  logger.info("Triggering Plex library scan", { sectionId });
  await plexGet(`/library/sections/${sectionId}/refresh`);
}

export async function refreshShow(): Promise<void> {
  const sectionId = await resolveSectionId();
  const showKey = await resolveShowRatingKey(sectionId);
  logger.info("Refreshing Plex show metadata", { ratingKey: showKey });
  await plexPost(`/library/metadata/${showKey}/refresh`);
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

function buildEpisodeSummary(ep: EpisodeSummary): string {
  const parts = [ep.episodeDescription.trim()];
  if (ep.chapters) parts.push(`Manga Chapter(s): ${ep.chapters}`);
  if (ep.originalEpisodes) parts.push(`Original Anime Episode(s): ${ep.originalEpisodes}`);
  return parts.join("\n\n");
}

function buildSeasonSummary(arc: ArcSummary): string {
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
