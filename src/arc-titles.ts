// Arc titles that have multiple accepted spellings in the wild. Each set maps to
// a single canonical form so a lookup matches regardless of which spelling the
// RSS title (or the official sheets) uses. The dataset spells these "Alabasta"
// and "Whisky Peak"; users/feeds sometimes write "Arabasta"/"Whiskey Peak".
//
// Lives in its own module (rather than metadata.ts) so the Google Sheet modules
// can use it without importing metadata.ts — which itself consults the sheets.
const ARC_TITLE_ALIASES: Record<string, string> = {
  arabasta: "alabasta",
  "whiskey peak": "whisky peak",
};

/**
 * Normalizes an arc title for matching: lowercased, whitespace-collapsed, with
 * known spelling variants folded to a single canonical form. Use this whenever
 * comparing arc titles from external sources (RSS, the Google Sheets) so the
 * accepted spellings are treated interchangeably.
 */
export function canonicalizeArcTitle(raw: string): string {
  const t = (raw ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  return ARC_TITLE_ALIASES[t] ?? t;
}
