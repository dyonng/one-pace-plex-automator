import { STATUS_ORDER } from "./util";

// Sorting lives outside the component so it can be unit tested without a DOM.
// The table renders whatever order it is handed.

export type SortKey = "se" | "arc" | "status" | "resolution" | "file" | "size" | "updated";
export type SortDir = "asc" | "desc";

export interface SortState {
  key: SortKey;
  dir: SortDir;
}

/** Newest first: the pipeline is normally read from the most recent activity. */
export const DEFAULT_SORT: SortState = { key: "updated", dir: "desc" };

/** Descending is the useful default for time and size; A–Z for everything else. */
const DEFAULT_DIR: Record<SortKey, SortDir> = {
  se: "asc",
  arc: "asc",
  status: "asc",
  resolution: "desc",
  file: "asc",
  size: "desc",
  updated: "desc",
};

/** Clicking the active column flips it; a new column starts at its natural direction. */
export function toggleSort(current: SortState, key: SortKey): SortState {
  if (current.key === key) return { key, dir: current.dir === "asc" ? "desc" : "asc" };
  return { key, dir: DEFAULT_DIR[key] };
}

/** Structural subset of an episode row — keeps this module free of fetch/api imports. */
export interface SortableEpisode {
  crc32: string;
  arc_part: number;
  episode_num: number;
  arc_title: string;
  status: string;
  resolution: string;
  final_filename: string | null;
  original_filename: string | null;
  file_size: number | null;
  updated_at: number;
}

/** The vertical resolution in a tag ("1080p" → 1080), or null when unparseable. */
function resolutionRank(resolution: string): number | null {
  const match = resolution?.match(/(\d{3,4})p/i);
  return match ? parseInt(match[1], 10) : null;
}

type SortValue = string | number | null;

function valueOf(ep: SortableEpisode, key: SortKey): SortValue {
  switch (key) {
    case "se":
      // Composite so an arc sorts before its own episodes.
      return ep.arc_part * 1000 + ep.episode_num;
    case "arc":
      return ep.arc_title || null;
    case "status": {
      const i = STATUS_ORDER.indexOf(ep.status);
      // Unrecognised statuses sort after every known one rather than at the top.
      return i === -1 ? STATUS_ORDER.length : i;
    }
    case "resolution":
      return resolutionRank(ep.resolution);
    case "file":
      return ep.final_filename ?? ep.original_filename ?? null;
    case "size":
      return ep.file_size;
    case "updated":
      return ep.updated_at;
  }
}

function compareValues(a: SortValue, b: SortValue, dir: SortDir): number {
  // Missing values sink to the bottom in both directions — flipping the sort
  // should not bury the rows that actually have data.
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;

  const c =
    typeof a === "number" && typeof b === "number"
      ? a - b
      : String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
  return dir === "asc" ? c : -c;
}

export function sortEpisodes<T extends SortableEpisode>(episodes: T[], state: SortState): T[] {
  return [...episodes].sort((a, b) => {
    const primary = compareValues(valueOf(a, state.key), valueOf(b, state.key), state.dir);
    if (primary !== 0) return primary;
    // Deterministic tie-break so equal rows keep a stable position.
    return compareValues(valueOf(a, "se"), valueOf(b, "se"), "asc");
  });
}
