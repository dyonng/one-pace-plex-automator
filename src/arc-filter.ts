import { canonicalizeArcTitle } from "./arc-titles";

/**
 * Optional per-arc scoping. An arc that's filtered out is not tracked at all:
 * it disappears from coverage and the metadata audit, isn't reconciled, and new
 * releases for it aren't queued. Useful for skipping content you don't want in
 * the library (the Specials arc being the usual case).
 *
 * Entries are arc parts ("0", "24") or arc titles ("Specials", "Wano"), comma
 * separated. Titles go through canonicalizeArcTitle so spelling variants
 * (Arabasta/Alabasta) match either way. An empty include list means "everything".
 */

export interface ArcFilter {
  include: Set<string>;
  exclude: Set<string>;
}

/** Normalizes one entry to either its numeric part or a canonical title key. */
function normalizeEntry(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  if (/^\d+$/.test(v)) return `#${Number(v)}`;
  return `t:${canonicalizeArcTitle(v)}`;
}

function parseList(raw: string): Set<string> {
  const out = new Set<string>();
  for (const part of (raw ?? "").split(",")) {
    const n = normalizeEntry(part);
    if (n) out.add(n);
  }
  return out;
}

export function parseArcFilter(include: string, exclude: string): ArcFilter {
  return { include: parseList(include), exclude: parseList(exclude) };
}

/**
 * True when an arc should be tracked. Exclude always wins over include, so
 * listing an arc in both is unambiguous rather than order-dependent.
 */
export function isArcIncluded(filter: ArcFilter, arcPart: number, arcTitle: string): boolean {
  const keys = [`#${arcPart}`, `t:${canonicalizeArcTitle(arcTitle)}`];
  if (keys.some((k) => filter.exclude.has(k))) return false;
  if (filter.include.size === 0) return true;
  return keys.some((k) => filter.include.has(k));
}

/** True when no filtering is configured at all (the common case). */
export function isArcFilterEmpty(filter: ArcFilter): boolean {
  return filter.include.size === 0 && filter.exclude.size === 0;
}
