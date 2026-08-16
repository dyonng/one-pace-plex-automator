/**
 * The fan-made poster collections we can apply. Sets are NOT uniform — some have
 * no show poster, some skip seasons, only one ships specials art — so every
 * lookup may legitimately return null and callers must treat that as "skip",
 * not an error.
 */

const pad2 = (n: number): string => String(n).padStart(2, "0");

// eltharynd/OnePacerr keeps its sets under posters/<id>/ using Season<NN>.png.
const ONEPACERR_BASE = "https://raw.githubusercontent.com/eltharynd/OnePacerr/main/posters";

export interface PosterSet {
  id: string;
  label: string;
  credit: string;
  /** Resolves the set's base URL. SpykerNZ sets follow POSTER_REPO_RAW_BASE so
   *  an existing override (or a mirror) keeps working; others are pinned. */
  base: (configuredBase: string) => string;
  /** Filename of the show poster, or null when the set has none. */
  showFile: string | null;
  /** Filename for a season (0 = Specials), or null when unsupported. */
  seasonFile: (season: number) => string | null;
}

// SpykerNZ ships one season set with two alternate show designs.
const spykerSeason = (n: number): string =>
  n === 0 ? "season-specials-poster.png" : `season${pad2(n)}-poster.png`;

// eltharynd's sets: Season00.png = Specials.
const onepacerrSeason = (n: number): string => `Season${pad2(n)}.png`;

export const POSTER_SETS: readonly PosterSet[] = [
  {
    id: "spykernz",
    label: "SpykerNZ",
    credit: "art by /u/piratezekk, distributed via SpykerNZ/one-pace-for-plex",
    base: (c) => c,
    showFile: "poster.png",
    seasonFile: spykerSeason,
  },
  {
    id: "spykernz-alt",
    label: "SpykerNZ (alt)",
    credit: "alternate show design from the same SpykerNZ set",
    base: (c) => c,
    showFile: "poster-2.png",
    seasonFile: spykerSeason,
  },
  {
    id: "piratezekk",
    label: "piratezekk",
    credit: "via eltharynd/OnePacerr — the only set with specials art",
    base: () => `${ONEPACERR_BASE}/piratezekk`,
    showFile: "poster.png",
    seasonFile: onepacerrSeason,
  },
  {
    id: "mizzoufan523",
    label: "mizzoufan523",
    credit: "via eltharynd/OnePacerr — seasons only, no show poster",
    base: () => `${ONEPACERR_BASE}/mizzoufan523`,
    showFile: null,
    seasonFile: onepacerrSeason,
  },
  {
    id: "official",
    label: "Official",
    credit: "via eltharynd/OnePacerr — a few seasons are missing",
    base: () => `${ONEPACERR_BASE}/official`,
    showFile: "poster.png",
    seasonFile: onepacerrSeason,
  },
];

export const DEFAULT_POSTER_SET = "spykernz";

export function getPosterSet(id: string): PosterSet {
  return POSTER_SETS.find((s) => s.id === id) ?? POSTER_SETS[0];
}

/** Older releases stored this setting as the show-design number 1 or 2. */
export function normalizePosterSetId(raw: string): string {
  const v = (raw ?? "").trim();
  if (v === "1") return "spykernz";
  if (v === "2") return "spykernz-alt";
  return POSTER_SETS.some((s) => s.id === v) ? v : DEFAULT_POSTER_SET;
}

/**
 * URL for a target within a set. `key` is "show" or a season number as a string.
 * Returns null when the set has no art for that target.
 */
export function posterSetUrl(set: PosterSet, key: string, configuredBase: string): string | null {
  const b = set.base(configuredBase).replace(/\/+$/, "");
  if (key === "show") return set.showFile ? `${b}/${set.showFile}` : null;
  const n = Number(key);
  if (!Number.isInteger(n) || n < 0) return null;
  const file = set.seasonFile(n);
  return file ? `${b}/${file}` : null;
}

export interface PosterSetView {
  id: string;
  label: string;
  credit: string;
  /** Image to show in the picker — the show poster, or season 1 for sets
   *  that don't ship one, so every set still previews as something. */
  previewUrl: string | null;
}

export function describePosterSets(configuredBase: string): PosterSetView[] {
  return POSTER_SETS.map((s) => ({
    id: s.id,
    label: s.label,
    credit: s.credit,
    previewUrl: posterSetUrl(s, "show", configuredBase) ?? posterSetUrl(s, "1", configuredBase),
  }));
}
