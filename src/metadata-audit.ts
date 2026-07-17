import { createHash } from "crypto";
import * as jpeg from "jpeg-js";
import { PNG } from "pngjs";
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
  setThumbCheck,
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
  fetchThumbBytes,
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

// A thumbnail whose max per-channel pixel stddev is below this is a single-color
// frame (fade-to-black/white transition Plex grabbed) — treat as no thumbnail.
// Real frames measure well above this; JPEG noise on a flat frame stays under it.
const BLANK_STDDEV_THRESHOLD = 8;
// How many uncached thumbnails to fetch+analyze concurrently per pass.
const THUMB_ANALYSIS_CONCURRENCY = 6;
// Fraction of near-transparent pixels above which a thumbnail is "empty" — a
// transparent PNG that renders as the Plex backdrop showing through.
const BLANK_TRANSPARENT_FRACTION = 0.85;
// Bump when the detection logic changes so cached verdicts (thumb_checked_path)
// are recomputed even for thumbnails whose version hasn't changed.
const THUMB_DETECTOR_VERSION = "v3";

const thumbCacheKey = (thumbPath: string): string => `${THUMB_DETECTOR_VERSION}:${thumbPath}`;

interface ThumbStats {
  rgbStddev: number;      // max per-channel stddev over opaque pixels
  transparentFrac: number; // fraction of near-transparent pixels
}

/** Decodes a JPEG or PNG to RGBA pixels, or null if the format is unsupported. */
function decodeImage(buf: Buffer): { data: Uint8Array | Buffer; width: number; height: number } | null {
  // JPEG: FF D8 FF
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    try {
      const img = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 256 });
      return { data: img.data, width: img.width, height: img.height };
    } catch {
      return null;
    }
  }
  // PNG: 89 50 4E 47
  if (buf.length > 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    try {
      const png = PNG.sync.read(buf); // always RGBA
      return { data: png.data, width: png.width, height: png.height };
    } catch {
      return null;
    }
  }
  return null;
}

/** Pixel statistics (color spread + transparency) for a thumbnail, or null. */
function thumbStats(buf: Buffer): ThumbStats | null {
  const img = decodeImage(buf);
  if (!img) return null;
  const n = img.width * img.height;
  if (!n) return null;

  let transparent = 0;
  let opaque = 0;
  const sum = [0, 0, 0];
  const sumSq = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const a = img.data[i * 4 + 3];
    if (a < 16) {
      transparent++;
      continue; // don't let undefined RGB behind transparent pixels skew the spread
    }
    opaque++;
    for (let c = 0; c < 3; c++) {
      const v = img.data[i * 4 + c];
      sum[c] += v;
      sumSq[c] += v * v;
    }
  }

  let maxStd = 0;
  if (opaque > 0) {
    for (let c = 0; c < 3; c++) {
      const mean = sum[c] / opaque;
      maxStd = Math.max(maxStd, Math.sqrt(Math.max(0, sumSq[c] / opaque - mean * mean)));
    }
  }
  return { rgbStddev: maxStd, transparentFrac: transparent / n };
}

type ThumbAnalysis =
  | { kind: "stats"; stats: ThumbStats }
  | { kind: "undecodable"; sig: string } // fetched bytes, but not a valid image
  | { kind: "missing"; status: number }  // server returned non-2xx (e.g. 404 — dangling thumb)
  | { kind: "unfetchable" };             // network error / timeout — transient

/**
 * Fetches a thumbnail and analyzes it. Tries the small transcode first, then
 * the raw image. A valid thumbnail decodes as JPEG or PNG. Distinguishes: got
 * bytes but can't decode (undecodable → broken); server said non-2xx like 404
 * (missing → dangling reference); pure network failure (unfetchable → transient).
 */
async function analyzeThumb(thumbPath: string): Promise<ThumbAnalysis> {
  let sig = "";
  let httpStatus: number | null = null;
  for (const transcoded of [true, false]) {
    const r = await fetchThumbBytes(thumbPath, transcoded);
    if (r.ok) {
      if (!sig) sig = `${transcoded ? "t" : "r"}${r.buf.length}:${r.buf.subarray(0, 4).toString("hex")}`;
      const stats = thumbStats(r.buf);
      if (stats !== null) return { kind: "stats", stats };
    } else if (r.status !== null) {
      httpStatus = r.status; // a definitive server response (not a transient error)
    }
  }
  if (sig) return { kind: "undecodable", sig };
  if (httpStatus !== null) return { kind: "missing", status: httpStatus };
  return { kind: "unfetchable" };
}

/** A thumbnail is blank if it's mostly transparent or a single color. */
const isBlankStats = (s: ThumbStats): boolean =>
  s.transparentFrac >= BLANK_TRANSPARENT_FRACTION || s.rgbStddev < BLANK_STDDEV_THRESHOLD;

/**
 * Determines which episode thumbnails are blank single-color frames. Verdicts
 * are cached per (detector version + thumb version), so only new/changed thumbs
 * are fetched and analyzed after the first pass.
 */
async function detectBlankThumbs(
  episodes: EpisodeSummary[],
  snapshot: PlexMetadataSnapshot,
  prevStates: Map<string, MetaStateRow>
): Promise<Map<string, boolean>> {
  const blankById = new Map<string, boolean>();
  const toCheck: { id: string; path: string }[] = [];

  for (const ep of episodes) {
    const plexEp = snapshot.episodes.get(ep.seasonEpisodeId);
    if (!plexEp?.hasThumb || !plexEp.thumbPath) continue;
    const prev = prevStates.get(ep.seasonEpisodeId);
    if (prev?.thumb_checked_path === thumbCacheKey(plexEp.thumbPath)) {
      blankById.set(ep.seasonEpisodeId, prev.thumb_blank === 1);
    } else {
      toCheck.push({ id: ep.seasonEpisodeId, path: plexEp.thumbPath });
    }
  }

  if (toCheck.length === 0) return blankById;

  let blankFound = 0;
  let brokenFound = 0;
  let missingFound = 0;
  const unfetchableIds: string[] = [];
  const brokenSigs: string[] = [];
  const missingInfo: string[] = [];
  const measured: { id: string; std: number; tf: number }[] = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < toCheck.length) {
      const { id, path } = toCheck[cursor++];
      const res = await analyzeThumb(path);
      if (res.kind === "unfetchable") {
        unfetchableIds.push(id); // transient — leave uncached, retry next pass
        continue;
      }
      // Undecodable (fetched bytes, not a valid image) or missing (404 — the
      // thumb resource is gone) both mean there's no usable thumbnail. A valid
      // one decodes; these don't. Treat as blank so they get regenerated, and
      // cache so we don't re-fetch every pass.
      const blank = res.kind === "stats" ? isBlankStats(res.stats) : true;
      setThumbCheck(id, thumbCacheKey(path), blank);
      blankById.set(id, blank);
      if (res.kind === "undecodable") {
        brokenFound++;
        if (brokenSigs.length < 20) brokenSigs.push(`${id}[${res.sig}]`);
      } else if (res.kind === "missing") {
        missingFound++;
        if (missingInfo.length < 20) missingInfo.push(`${id}:${res.status}`);
      } else {
        measured.push({ id, std: res.stats.rgbStddev, tf: res.stats.transparentFrac });
      }
      if (blank) blankFound++;
    }
  };
  await Promise.all(Array.from({ length: THUMB_ANALYSIS_CONCURRENCY }, worker));

  // Surface the most-suspect episodes so borderline calls are diagnosable.
  const lowest = measured
    .sort((a, b) => b.tf - a.tf || a.std - b.std)
    .slice(0, 10)
    .map((m) => `${m.id}:std${m.std.toFixed(1)}/tr${Math.round(m.tf * 100)}%`);
  logger.info("Thumbnail blank-frame analysis", {
    analyzed: measured.length,
    blank: blankFound,
    broken: brokenFound,        // fetched but not a decodable image
    brokenSigs,                 // "<id>[<t|r><bytes>:<first4hex>]"
    missing: missingFound,      // server returned non-2xx (dangling thumb ref)
    missingInfo,                // "<id>:<httpStatus>"
    unfetchable: unfetchableIds.length, // network error — transient, retried next pass
    lowest,
  });
  return blankById;
}

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
  needsThumb: boolean;       // in Plex, no (usable) thumbnail, still under the retry cap
  thumbBlank: boolean;       // Plex has a thumb, but it's a blank single-color frame
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

  // A blank single-color still counts as no thumbnail — reclassify before
  // reconciling so the normal regeneration path picks those episodes up.
  const blankById = await detectBlankThumbs(episodes, snapshot, prevStates);

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

    const rawPlexEp = snapshot.episodes.get(ep.seasonEpisodeId);
    const thumbBlank = blankById.get(ep.seasonEpisodeId) === true;
    const plexEp = rawPlexEp && thumbBlank ? { ...rawPlexEp, hasThumb: false } : rawPlexEp;
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
      thumbBlank,
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
