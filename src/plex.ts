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

export async function triggerLibraryScan(sectionId: string): Promise<void> {
  logger.info("Triggering Plex library scan", { sectionId });
  await plexGet(`/library/sections/${sectionId}/refresh`);
}

export async function refreshShow(ratingKey: string): Promise<void> {
  logger.info("Refreshing Plex show metadata", { ratingKey });
  await plexPost(`/library/metadata/${ratingKey}/refresh`);
}

async function getShowRatingKey(sectionId: string): Promise<string | null> {
  const { PLEX_SERIES_RATING_KEY, SERIES_FOLDER_NAME } = getConfig();
  if (PLEX_SERIES_RATING_KEY) return PLEX_SERIES_RATING_KEY;

  try {
    const result = await plexGet<PlexContainer>(`/library/sections/${sectionId}/all`, {
      type: "2",
    });
    const show = result.MediaContainer.Metadata?.find((m) =>
      m.title.toLowerCase().includes(SERIES_FOLDER_NAME.toLowerCase())
    );
    return show?.ratingKey ?? null;
  } catch {
    return null;
  }
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

export async function syncSingleEpisode(
  sectionId: string,
  ep: EpisodeSummary
): Promise<void> {
  const showKey = await getShowRatingKey(sectionId);
  if (!showKey) {
    logger.warn("Could not find show in Plex", { show: getConfig().SERIES_FOLDER_NAME });
    return;
  }

  const episodeMap = await buildEpisodeKeyMap(showKey);
  const ratingKey = episodeMap.get(ep.seasonEpisodeId);
  if (!ratingKey) {
    logger.warn("Episode not found in Plex", { id: ep.seasonEpisodeId });
    return;
  }

  await updateEpisodeInPlex(ratingKey, ep);
  logger.info("Updated episode metadata", { id: ep.seasonEpisodeId, title: ep.episodeTitle });
}

export async function syncFullLibrary(
  sectionId: string,
  arcs: ArcSummary[],
  episodes: EpisodeSummary[]
): Promise<void> {
  const showKey = await getShowRatingKey(sectionId);
  if (!showKey) {
    logger.warn("Could not find show in Plex for full sync");
    return;
  }

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

  await refreshShow(showKey);
  logger.info("Full library sync complete", { updated, skipped });
}
