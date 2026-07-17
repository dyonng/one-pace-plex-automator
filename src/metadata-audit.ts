import { createHash } from "crypto";
import { logger } from "./logger";
import {
  getKv,
  setKv,
  getAllMetaStates,
  setDesiredMeta,
  setObservedMeta,
  setAppliedMeta,
  bumpThumbAttempt,
  resetThumbAttempts,
  resetAllThumbAttempts,
  type MetaStateRow,
} from "./db";
import {
  getAllArcs,
  getAllEpisodes,
  type ArcSummary,
  type EpisodeSummary,
} from "./metadata";
import {
  scanPlexMetadata,
  updateEpisodeInPlex,
  updateSeasonInPlex,
  refreshItem,
  analyzeItem,
  buildEpisodeSummary,
  buildSeasonSummary,
  refreshShow,
  type PlexItemMeta,
  type PlexMetadataSnapshot,
} from "./plex";

// Latest report for the dashboard — a single upserted kv row (mirrors coverage).
// The plex_meta_state table is the source of truth for reconcile decisions; this
// is just the display cache.
const KV_KEY = "metadata_audit_report";
const KV_SCANNED_AT = "metadata_audit_scanned_at";

// Stop re-triggering thumbnail generation after this many attempts — some
// episodes Plex simply can't/won't thumbnail, and we don't want to hammer it.
const THUMB_ATTEMPT_CAP = 3;
// Generation is asynchronous (Plex queues the analysis), so give it real time
// between attempts. Without this, back-to-back auto-reconciles would burn the
// whole attempt budget before Plex has worked through its queue.
const THUMB_RETRY_SPACING_MS = 30 * 60 * 1000;

export type MetadataState =
  | "ok"           // Plex matches the dataset (applied == desired)
  | "missing"      // in Plex but blank summary / placeholder title
  | "drifted"      // in Plex with text, but not our current dataset value
  | "not_in_plex"; // dataset lists it, no matching Plex episode yet

export interface MetadataAuditEpisode {
  arcPart: number;
  arcTitle: string;
  episodeNum: number;
  seasonEpisodeId: string;
  state: MetadataState;
  expectedTitle: string;
  plexTitle: string | null;
  needsThumb: boolean;       // in Plex, no thumbnail, still under the retry cap
  thumbUnavailable: boolean; // in Plex, no thumbnail, retry cap reached
}

export interface MetadataAuditArc {
  arcPart: number;
  arcTitle: string;
  arcSaga: string;
  seasonState: MetadataState;
  total: number;
  ok: number;
  missing: number;
  drifted: number;
  notInPlex: number;
  needsThumb: number;
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
    flagged: number;          // missing + drifted — actionable metadata
    needsThumb: number;
    thumbUnavailable: number;
  };
  seasonsFlagged: number;
  arcs: MetadataAuditArc[];
}

// Collapse whitespace so cosmetic differences don't read as drift.
const norm = (s: string | null | undefined): string => (s ?? "").replace(/\s+/g, " ").trim();

// Plex names an unmatched item by its file or a bare "Episode N" / "Season N".
const isPlaceholderTitle = (t: string): boolean => {
  const n = norm(t).toLowerCase();
  return n === "" || /^(episode|season)\s+\d+$/.test(n);
};

// Identity of the metadata we want in Plex: title + summary only (both
// observable from /allLeaves, so drift detection stays symmetric).
function desiredHash(title: string, summary: string): string {
  return createHash("sha1").update(norm(title) + "\x00" + norm(summary)).digest("hex");
}

const hasData = (title: string, summary: string): boolean =>
  norm(title).length > 0 || norm(summary).length > 0;

// True when Plex's copy already equals what we want (adopt without re-pushing).
function plexMatchesDesired(plex: PlexItemMeta, title: string, summary: string): boolean {
  return norm(plex.title) === norm(title) && norm(plex.summary) === norm(summary);
}

interface EpisodeStateView {
  state: MetadataState;
  needsMetadata: boolean; // should push (have data, in Plex, applied != desired or Plex lost it)
  needsThumb: boolean;
  thumbUnavailable: boolean;
}

/**
 * Reconciles one episode's persisted state against the dataset + a fresh Plex
 * observation, writing desired/observed/applied back to the row, and returns a
 * view describing what (if anything) needs doing. Pure bookkeeping — never calls
 * Plex; the caller performs any pushes/thumbnail triggers.
 */
function reconcileEpisodeState(
  ep: EpisodeSummary,
  plex: PlexItemMeta | undefined,
  prev: MetaStateRow | undefined
): EpisodeStateView {
  const title = ep.episodeTitle;
  const summary = buildEpisodeSummary(ep);
  const dHash = desiredHash(title, summary);
  setDesiredMeta(ep.seasonEpisodeId, ep.arcPart, ep.episodeNum, dHash);

  if (!plex) {
    setObservedMeta(ep.seasonEpisodeId, { inPlex: false, hasThumb: false, plexTitle: null, ratingKey: null });
    return { state: "not_in_plex", needsMetadata: false, needsThumb: false, thumbUnavailable: false };
  }

  const hasThumb = plex.hasThumb;
  setObservedMeta(ep.seasonEpisodeId, {
    inPlex: true,
    hasThumb,
    plexTitle: plex.title,
    ratingKey: plex.ratingKey,
  });
  if (hasThumb) resetThumbAttempts(ep.seasonEpisodeId);

  // Adopt Plex's copy as applied when it already matches — avoids needless
  // re-pushes for episodes synced before we tracked state.
  let applied = prev?.applied_hash ?? null;
  if (plexMatchesDesired(plex, title, summary)) {
    setAppliedMeta(ep.seasonEpisodeId, dHash);
    applied = dHash;
  }

  // Thumbnail need (independent of metadata).
  const attempts = prev?.thumb_attempts ?? 0;
  const needsThumb = !hasThumb && attempts < THUMB_ATTEMPT_CAP;
  const thumbUnavailable = !hasThumb && attempts >= THUMB_ATTEMPT_CAP;

  if (!hasData(title, summary)) {
    // Nothing to write — treat as ok for metadata, but thumbnails may still apply.
    return { state: "ok", needsMetadata: false, needsThumb, thumbUnavailable };
  }

  const plexEmpty = norm(plex.summary).length === 0 || isPlaceholderTitle(plex.title);
  const inSync = applied === dHash && !plexEmpty;

  if (inSync) return { state: "ok", needsMetadata: false, needsThumb, thumbUnavailable };

  const state: MetadataState = plexEmpty ? "missing" : "drifted";
  return { state, needsMetadata: true, needsThumb, thumbUnavailable };
}

interface SeasonView {
  state: MetadataState;
  needsMetadata: boolean;
}

function reconcileSeasonState(arc: ArcSummary, plex: PlexItemMeta | undefined): SeasonView {
  if (!plex) return { state: "not_in_plex", needsMetadata: false };
  const title = arc.arcTitle;
  const summary = buildSeasonSummary(arc);
  if (plexMatchesDesired(plex, title, summary)) return { state: "ok", needsMetadata: false };
  const plexEmpty = norm(plex.summary).length === 0 || isPlaceholderTitle(plex.title);
  return { state: plexEmpty ? "missing" : "drifted", needsMetadata: hasData(title, summary) };
}

function emptyArc(arcPart: number, arcTitle: string, arcSaga: string): MetadataAuditArc {
  return {
    arcPart, arcTitle, arcSaga, seasonState: "ok",
    total: 0, ok: 0, missing: 0, drifted: 0, notInPlex: 0, needsThumb: 0, episodes: [],
  };
}

interface ReconcileResult {
  report: MetadataAuditReport;
  episodesToPush: { ep: EpisodeSummary; ratingKey: string }[];
  seasonsToPush: { arc: ArcSummary; ratingKey: string }[];
  thumbsToGen: { id: string; ratingKey: string }[];
}

/**
 * Core pass: recompute desired state for the whole catalog, observe Plex once,
 * reconcile every row, and build both the display report and the action lists
 * (what to push / thumbnail). Does not perform the actions — callers decide.
 */
async function buildReconcile(): Promise<ReconcileResult> {
  const [arcs, episodes, snapshot]: [ArcSummary[], EpisodeSummary[], PlexMetadataSnapshot] =
    await Promise.all([getAllArcs(), getAllEpisodes(), scanPlexMetadata()]);

  const prevStates = new Map<string, MetaStateRow>();
  for (const row of getAllMetaStates()) prevStates.set(row.season_episode_id, row);

  const arcMap = new Map<number, MetadataAuditArc>();
  const seasonsToPush: { arc: ArcSummary; ratingKey: string }[] = [];
  for (const a of arcs) {
    const arc = emptyArc(a.arcPart, a.arcTitle, a.arcSaga);
    const plexSeason = snapshot.seasons.get(a.arcPart);
    const sv = reconcileSeasonState(a, plexSeason);
    arc.seasonState = sv.state;
    if (sv.needsMetadata && plexSeason) seasonsToPush.push({ arc: a, ratingKey: plexSeason.ratingKey });
    arcMap.set(a.arcPart, arc);
  }

  const episodesToPush: { ep: EpisodeSummary; ratingKey: string }[] = [];
  const thumbsToGen: { id: string; ratingKey: string }[] = [];

  for (const ep of episodes) {
    let arc = arcMap.get(ep.arcPart);
    if (!arc) {
      arc = emptyArc(ep.arcPart, ep.arcTitle, ep.arcSaga);
      arcMap.set(ep.arcPart, arc);
    }

    const plexEp = snapshot.episodes.get(ep.seasonEpisodeId);
    const prev = prevStates.get(ep.seasonEpisodeId);
    const view = reconcileEpisodeState(ep, plexEp, prev);

    if (view.needsMetadata && plexEp) episodesToPush.push({ ep, ratingKey: plexEp.ratingKey });
    // Only re-trigger generation once the previous attempt has had time to work
    // through Plex's async analysis queue — the episode still counts as
    // needsThumb in the report either way.
    const lastAttempt = prev?.thumb_last_attempt_at ?? null;
    const attemptDue = lastAttempt === null || Date.now() - lastAttempt >= THUMB_RETRY_SPACING_MS;
    if (view.needsThumb && plexEp && attemptDue) {
      thumbsToGen.push({ id: ep.seasonEpisodeId, ratingKey: plexEp.ratingKey });
    }

    arc.total++;
    if (view.state === "ok") arc.ok++;
    else if (view.state === "missing") arc.missing++;
    else if (view.state === "drifted") arc.drifted++;
    else arc.notInPlex++;
    if (view.needsThumb) arc.needsThumb++;

    arc.episodes.push({
      arcPart: ep.arcPart,
      arcTitle: ep.arcTitle,
      episodeNum: ep.episodeNum,
      seasonEpisodeId: ep.seasonEpisodeId,
      state: view.state,
      expectedTitle: ep.episodeTitle,
      plexTitle: plexEp?.title ?? null,
      needsThumb: view.needsThumb,
      thumbUnavailable: view.thumbUnavailable,
    });
  }

  const arcsOut = [...arcMap.values()].sort((a, b) => a.arcPart - b.arcPart);
  for (const a of arcsOut) a.episodes.sort((x, y) => x.episodeNum - y.episodeNum);

  const totals = arcsOut.reduce(
    (t, a) => {
      t.episodes += a.total;
      t.ok += a.ok;
      t.missing += a.missing;
      t.drifted += a.drifted;
      t.notInPlex += a.notInPlex;
      t.needsThumb += a.needsThumb;
      return t;
    },
    { episodes: 0, ok: 0, missing: 0, drifted: 0, notInPlex: 0, flagged: 0, needsThumb: 0, thumbUnavailable: 0 }
  );
  totals.flagged = totals.missing + totals.drifted;
  totals.thumbUnavailable = arcsOut.reduce(
    (n, a) => n + a.episodes.filter((e) => e.thumbUnavailable).length,
    0
  );
  const seasonsFlagged = arcsOut.filter(
    (a) => a.seasonState === "missing" || a.seasonState === "drifted"
  ).length;

  const report: MetadataAuditReport = { scannedAt: Date.now(), totals, seasonsFlagged, arcs: arcsOut };
  return { report, episodesToPush, seasonsToPush, thumbsToGen };
}

function storeReport(report: MetadataAuditReport): void {
  setKv(KV_KEY, JSON.stringify(report));
  setKv(KV_SCANNED_AT, String(report.scannedAt));
}

/**
 * Read-only audit: observe Plex, reconcile the state table, store the report.
 * Never writes to Plex — use reconcilePlexMetadata to actually fix things.
 */
export async function scanMetadataAudit(): Promise<MetadataAuditReport> {
  const { report } = await buildReconcile();
  storeReport(report);
  logger.info("Metadata audit complete", { ...report.totals, seasonsFlagged: report.seasonsFlagged });
  return report;
}

export interface ReconcileSummary {
  episodesUpdated: number;
  seasonsUpdated: number;
  thumbsTriggered: number;
  flaggedEpisodes: number;
  flaggedSeasons: number;
}

/**
 * The engine: observe Plex, then push metadata for every flagged (missing /
 * drifted) season & episode where we hold canonical data, and trigger thumbnail
 * generation for episodes lacking one (under the retry cap). Re-audits afterward
 * so the stored report reflects the fix. Idempotent and restart-safe.
 */
export async function reconcilePlexMetadata(
  opts: { thumbnails?: boolean } = {}
): Promise<ReconcileSummary> {
  const doThumbs = opts.thumbnails ?? true;
  const { episodesToPush, seasonsToPush, thumbsToGen } = await buildReconcile();

  let seasonsUpdated = 0;
  for (const { arc, ratingKey } of seasonsToPush) {
    try {
      await updateSeasonInPlex(ratingKey, arc);
      seasonsUpdated++;
    } catch (err) {
      logger.warn("Reconcile: season push failed", { part: arc.arcPart, error: (err as Error).message });
    }
  }

  let episodesUpdated = 0;
  for (const { ep, ratingKey } of episodesToPush) {
    try {
      await updateEpisodeInPlex(ratingKey, ep);
      setAppliedMeta(ep.seasonEpisodeId, desiredHash(ep.episodeTitle, buildEpisodeSummary(ep)));
      episodesUpdated++;
    } catch (err) {
      logger.warn("Reconcile: episode push failed", { id: ep.seasonEpisodeId, error: (err as Error).message });
    }
  }

  let thumbsTriggered = 0;
  if (doThumbs) {
    for (const { id, ratingKey } of thumbsToGen) {
      try {
        await refreshItem(ratingKey);
        await analyzeItem(ratingKey);
        bumpThumbAttempt(id);
        thumbsTriggered++;
      } catch (err) {
        logger.warn("Reconcile: thumbnail trigger failed", { id, error: (err as Error).message });
      }
    }
  }

  if (seasonsUpdated || episodesUpdated) await refreshShow();

  // Re-audit so the stored report reflects the pushes (thumbnails show up later).
  const { report } = await buildReconcile();
  storeReport(report);

  const summary: ReconcileSummary = {
    episodesUpdated,
    seasonsUpdated,
    thumbsTriggered,
    flaggedEpisodes: episodesToPush.length,
    flaggedSeasons: seasonsToPush.length,
  };
  logger.info("Reconcile complete", { ...summary });
  return summary;
}

/**
 * Manual "try again" for thumbnails: clears every episode's attempt counter
 * (including the ones that hit the cap and were written off), then runs a
 * reconcile so refresh(force)+analyze fires immediately for everything still
 * missing a thumbnail. Generation is async — results appear on later scans.
 */
export async function retryThumbnails(): Promise<ReconcileSummary & { reset: number }> {
  const reset = resetAllThumbAttempts();
  const summary = await reconcilePlexMetadata({ thumbnails: true });
  return { ...summary, reset };
}

/**
 * Cheap source-refresh hook: recompute every episode's desired hash from the
 * dataset (no Plex calls). Episodes whose canonical text changed now have
 * desired != applied, so the next reconcile picks them up automatically.
 */
export async function markDirtyFromSource(): Promise<void> {
  const episodes = await getAllEpisodes();
  for (const ep of episodes) {
    setDesiredMeta(
      ep.seasonEpisodeId,
      ep.arcPart,
      ep.episodeNum,
      desiredHash(ep.episodeTitle, buildEpisodeSummary(ep))
    );
  }
  logger.debug("Marked desired metadata from source", { episodes: episodes.length });
}

/** Timestamp of the last stored audit/reconcile, or null if none has run. */
export function getAuditScannedAt(): number | null {
  const raw = getKv(KV_SCANNED_AT);
  return raw ? Number(raw) : null;
}

/** Returns the last stored report from kv, or null if none has run yet. */
export function getStoredAudit(): MetadataAuditReport | null {
  const raw = getKv(KV_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as MetadataAuditReport;
  } catch {
    return null;
  }
}
