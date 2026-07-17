import { logger } from "./logger";
import { getKv, setKv } from "./db";
import {
  getAllArcs,
  getAllEpisodes,
  type ArcSummary,
  type EpisodeSummary,
} from "./metadata";
import {
  scanPlexMetadata,
  syncMetadataTargeted,
  buildEpisodeSummary,
  buildSeasonSummary,
  type PlexItemMeta,
} from "./plex";

// Latest audit only — a single upserted kv row (mirrors the coverage report), so
// it never grows and survives restarts. The dashboard reads this; a scan
// overwrites it.
const KV_KEY = "metadata_audit_report";
// Lightweight companion so the status endpoint can report freshness without
// parsing the full report on every poll.
const KV_SCANNED_AT = "metadata_audit_scanned_at";

export type MetadataState =
  | "ok"           // Plex title + summary match the canonical dataset
  | "missing"      // in Plex but summary blank / title is a placeholder (never synced)
  | "drifted"      // in Plex with real text, but it differs from the dataset
  | "not_in_plex"; // dataset lists it, but there's no matching Plex episode yet

export interface MetadataAuditEpisode {
  arcPart: number;
  arcTitle: string;
  episodeNum: number;
  seasonEpisodeId: string;
  state: MetadataState;
  expectedTitle: string;
  plexTitle: string | null; // null when not in Plex
  titleMismatch: boolean;
  summaryMismatch: boolean;
}

export interface MetadataAuditArc {
  arcPart: number;
  arcTitle: string;
  arcSaga: string;
  seasonState: MetadataState; // audit of the season/arc metadata itself
  total: number;
  ok: number;
  missing: number;
  drifted: number;
  notInPlex: number;
  episodes: MetadataAuditEpisode[];
}

export interface MetadataAuditReport {
  scannedAt: number;
  totals: {
    episodes: number;
    ok: number;
    missing: number;
    drifted: number;
    notInPlex: number;
    flagged: number; // missing + drifted — the actionable set
  };
  seasonsFlagged: number;
  arcs: MetadataAuditArc[];
}

// Collapse whitespace so cosmetic differences (Plex re-wrapping, trailing
// newlines) don't read as drift — only real content changes are flagged.
const norm = (s: string | null | undefined): string => (s ?? "").replace(/\s+/g, " ").trim();

// Plex names an unmatched item by its file or a bare "Episode N" / "Season N".
const isPlaceholderTitle = (t: string): boolean => {
  const n = norm(t).toLowerCase();
  return n === "" || /^(episode|season)\s+\d+$/.test(n);
};

interface Classification {
  state: MetadataState;
  titleMismatch: boolean;
  summaryMismatch: boolean;
}

function classify(
  expectedTitle: string,
  expectedSummary: string,
  plex: PlexItemMeta | undefined
): Classification {
  if (!plex) return { state: "not_in_plex", titleMismatch: false, summaryMismatch: false };

  const et = norm(expectedTitle);
  const es = norm(expectedSummary);
  const pt = norm(plex.title);
  const ps = norm(plex.summary);

  const titleMismatch = et.length > 0 && et !== pt;
  const summaryMismatch = es.length > 0 && es !== ps;

  // Missing = we have real text to write, but Plex has none: a blank summary
  // (we always write one) or a placeholder title.
  const missing =
    (es.length > 0 && ps.length === 0) ||
    (et.length > 0 && isPlaceholderTitle(plex.title));

  if (missing) return { state: "missing", titleMismatch, summaryMismatch };
  if (titleMismatch || summaryMismatch) return { state: "drifted", titleMismatch, summaryMismatch };
  return { state: "ok", titleMismatch: false, summaryMismatch: false };
}

function emptyArc(arcPart: number, arcTitle: string, arcSaga: string): MetadataAuditArc {
  return {
    arcPart,
    arcTitle,
    arcSaga,
    seasonState: "ok",
    total: 0,
    ok: 0,
    missing: 0,
    drifted: 0,
    notInPlex: 0,
    episodes: [],
  };
}

/**
 * Diffs Plex's current season/episode title + summary against the canonical
 * dataset and classifies every episode as ok / missing / drifted / not_in_plex.
 * Reads Plex in two requests (see scanPlexMetadata); stores the report in kv.
 */
export async function scanMetadataAudit(): Promise<MetadataAuditReport> {
  const [arcs, episodes, snapshot] = await Promise.all([
    getAllArcs(),
    getAllEpisodes(),
    scanPlexMetadata(),
  ]);

  const arcMap = new Map<number, MetadataAuditArc>();

  // Seed arcs from the dataset and audit each season's own metadata.
  for (const a of arcs) {
    const arc = emptyArc(a.arcPart, a.arcTitle, a.arcSaga);
    arc.seasonState = classify(a.arcTitle, buildSeasonSummary(a), snapshot.seasons.get(a.arcPart)).state;
    arcMap.set(a.arcPart, arc);
  }

  for (const ep of episodes) {
    let arc = arcMap.get(ep.arcPart);
    if (!arc) {
      // Episode's arc isn't in getAllArcs() (shouldn't normally happen) — seed one.
      arc = emptyArc(ep.arcPart, ep.arcTitle, ep.arcSaga);
      arcMap.set(ep.arcPart, arc);
    }

    const { state, titleMismatch, summaryMismatch } = classify(
      ep.episodeTitle,
      buildEpisodeSummary(ep),
      snapshot.episodes.get(ep.seasonEpisodeId)
    );

    arc.total++;
    if (state === "ok") arc.ok++;
    else if (state === "missing") arc.missing++;
    else if (state === "drifted") arc.drifted++;
    else arc.notInPlex++;

    arc.episodes.push({
      arcPart: ep.arcPart,
      arcTitle: ep.arcTitle,
      episodeNum: ep.episodeNum,
      seasonEpisodeId: ep.seasonEpisodeId,
      state,
      expectedTitle: ep.episodeTitle,
      plexTitle: snapshot.episodes.get(ep.seasonEpisodeId)?.title ?? null,
      titleMismatch,
      summaryMismatch,
    });
  }

  const arcsOut = [...arcMap.values()].sort((a, b) => a.arcPart - b.arcPart);
  for (const a of arcsOut) a.episodes.sort((x, y) => x.episodeNum - y.episodeNum);

  const totals = arcsOut.reduce(
    (t, a) => ({
      episodes: t.episodes + a.total,
      ok: t.ok + a.ok,
      missing: t.missing + a.missing,
      drifted: t.drifted + a.drifted,
      notInPlex: t.notInPlex + a.notInPlex,
      flagged: 0,
    }),
    { episodes: 0, ok: 0, missing: 0, drifted: 0, notInPlex: 0, flagged: 0 }
  );
  totals.flagged = totals.missing + totals.drifted;

  const seasonsFlagged = arcsOut.filter(
    (a) => a.seasonState === "missing" || a.seasonState === "drifted"
  ).length;

  const report: MetadataAuditReport = {
    scannedAt: Date.now(),
    totals,
    seasonsFlagged,
    arcs: arcsOut,
  };

  setKv(KV_KEY, JSON.stringify(report));
  setKv(KV_SCANNED_AT, String(report.scannedAt));
  logger.info("Metadata audit complete", { ...totals, seasonsFlagged });
  return report;
}

const isFlagged = (s: MetadataState): boolean => s === "missing" || s === "drifted";

/**
 * Audits metadata, then pushes the dataset's title/summary to Plex for only the
 * flagged (missing/drifted) seasons and episodes — an O(flagged) write instead
 * of the O(everything) full sync. Re-audits afterward so the report reflects the
 * fix. Returns what was written.
 */
export async function syncFlaggedMetadata(): Promise<{
  seasonsUpdated: number;
  episodesUpdated: number;
  flaggedEpisodes: number;
  flaggedSeasons: number;
}> {
  const report = await scanMetadataAudit();

  const flaggedEpisodeIds = new Set<string>();
  const flaggedArcParts = new Set<number>();
  for (const arc of report.arcs) {
    if (isFlagged(arc.seasonState)) flaggedArcParts.add(arc.arcPart);
    for (const ep of arc.episodes) {
      if (isFlagged(ep.state)) flaggedEpisodeIds.add(ep.seasonEpisodeId);
    }
  }

  if (flaggedEpisodeIds.size === 0 && flaggedArcParts.size === 0) {
    return { seasonsUpdated: 0, episodesUpdated: 0, flaggedEpisodes: 0, flaggedSeasons: 0 };
  }

  const [allArcs, allEpisodes] = await Promise.all([getAllArcs(), getAllEpisodes()]);
  const arcs: ArcSummary[] = allArcs.filter((a) => flaggedArcParts.has(a.arcPart));
  const eps: EpisodeSummary[] = allEpisodes.filter((e) => flaggedEpisodeIds.has(e.seasonEpisodeId));

  const res = await syncMetadataTargeted(arcs, eps);
  // Reflect the fix in the stored report.
  await scanMetadataAudit();

  return {
    seasonsUpdated: res.seasonsUpdated,
    episodesUpdated: res.episodesUpdated,
    flaggedEpisodes: flaggedEpisodeIds.size,
    flaggedSeasons: flaggedArcParts.size,
  };
}

/** Timestamp of the last stored audit, or null if none has run. Cheap to read. */
export function getAuditScannedAt(): number | null {
  const raw = getKv(KV_SCANNED_AT);
  return raw ? Number(raw) : null;
}

/** Returns the last audit from the kv store, or null if none has run yet. */
export function getStoredAudit(): MetadataAuditReport | null {
  const raw = getKv(KV_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as MetadataAuditReport;
  } catch {
    return null;
  }
}
