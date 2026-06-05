import axios from "axios";
import { getConfig } from "./config";
import { logger } from "./logger";

interface PlexEpisode {
  ratingKey: string;
  title: string;
  index: number;
  parentIndex: number; // season number
  summary: string;
}

async function plexGet<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const { PLEX_URL, PLEX_TOKEN } = getConfig();
  const resp = await axios.get<T>(`${PLEX_URL}${path}`, {
    params: { "X-Plex-Token": PLEX_TOKEN, ...params },
    headers: { Accept: "application/json" },
    timeout: 15_000,
  });
  return resp.data;
}

async function plexPut(path: string, params: Record<string, string> = {}): Promise<void> {
  const { PLEX_URL, PLEX_TOKEN } = getConfig();
  await axios.put(`${PLEX_URL}${path}`, null, {
    params: { "X-Plex-Token": PLEX_TOKEN, ...params },
    timeout: 15_000,
  });
}

export async function triggerLibraryScan(sectionId: string): Promise<void> {
  logger.info("Triggering Plex library scan", { sectionId });
  await plexGet(`/library/sections/${sectionId}/refresh`);
}

export async function findEpisodeRatingKey(
  sectionId: string,
  seriesRatingKey: string | undefined,
  seasonNum: number,
  episodeNum: number
): Promise<string | null> {
  try {
    let showKey = seriesRatingKey;

    if (!showKey) {
      // Search for the show in the library section
      const searchResult = await plexGet<{
        MediaContainer: { Metadata: Array<{ ratingKey: string; title: string }> };
      }>(`/library/sections/${sectionId}/all`, { title: "One Pace", type: "2" });
      const show = searchResult.MediaContainer.Metadata?.find(
        (m) => m.title.toLowerCase().includes("one pace")
      );
      if (!show) return null;
      showKey = show.ratingKey;
    }

    // Get seasons
    const seasonsResult = await plexGet<{
      MediaContainer: { Metadata: Array<{ ratingKey: string; index: number }> };
    }>(`/library/metadata/${showKey}/children`);

    const season = seasonsResult.MediaContainer.Metadata?.find((s) => s.index === seasonNum);
    if (!season) return null;

    // Get episodes in season
    const epsResult = await plexGet<{
      MediaContainer: { Metadata: PlexEpisode[] };
    }>(`/library/metadata/${season.ratingKey}/children`);

    const ep = epsResult.MediaContainer.Metadata?.find((e) => e.index === episodeNum);
    return ep?.ratingKey ?? null;
  } catch (err) {
    logger.warn("Could not find episode rating key in Plex", { error: (err as Error).message });
    return null;
  }
}

export async function updateEpisodeMetadata(
  ratingKey: string,
  title: string,
  summary: string
): Promise<void> {
  logger.info("Updating Plex episode metadata", { ratingKey, title });
  await plexPut(`/library/metadata/${ratingKey}`, {
    title,
    summary,
    titleSort: title,
    "X-Plex-Token": getConfig().PLEX_TOKEN,
  });
}

export async function refreshEpisodeMetadata(ratingKey: string): Promise<void> {
  await plexGet(`/library/metadata/${ratingKey}/refresh`);
}
