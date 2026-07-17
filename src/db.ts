import Database from "better-sqlite3";
import path from "path";
import { DATA_DIR } from "./constants";

export type EpisodeStatus =
  | "available" // discovered but not yet queued (manual-download mode)
  | "pending"
  | "downloading"
  | "processing"
  | "done"
  | "failed";

export interface EpisodeRecord {
  crc32: string;
  arc_num: number;
  arc_title: string;
  arc_part: number;
  episode_num: number;
  resolution: string;
  original_filename: string;
  final_filename: string | null;
  status: EpisodeStatus;
  torrent_hash: string | null;
  magnet_uri: string | null;
  error_message: string | null;
  rss_guid: string;
  changelog: string[];
  // True when this release is the extended cut. Persisted so a provisional
  // download (one started before the catalog listed the episode) still names
  // the file with the [Extended] tag once it completes.
  extended: boolean;
  created_at: number;
  updated_at: number;
}

// Raw row as stored in SQLite: changelog is a JSON string, extended an int 0/1.
type EpisodeRow = Omit<EpisodeRecord, "changelog" | "extended"> & {
  changelog: string;
  extended: number;
};

function rowToRecord(row: EpisodeRow): EpisodeRecord {
  let changelog: string[] = [];
  try {
    changelog = JSON.parse(row.changelog ?? "[]");
  } catch {
    changelog = [];
  }
  return { ...row, changelog, extended: Boolean(row.extended) };
}

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;
  const dbPath = path.join(DATA_DIR, "state.db");
  _db = new Database(dbPath);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  migrate(_db);
  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

function migrate(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS episodes (
      crc32             TEXT PRIMARY KEY,
      arc_num           INTEGER NOT NULL,
      arc_title         TEXT NOT NULL,
      arc_part          INTEGER NOT NULL,
      episode_num       INTEGER NOT NULL,
      resolution        TEXT NOT NULL DEFAULT '1080p',
      original_filename TEXT NOT NULL,
      final_filename    TEXT,
      status            TEXT NOT NULL DEFAULT 'pending',
      torrent_hash      TEXT,
      magnet_uri        TEXT,
      error_message     TEXT,
      rss_guid          TEXT NOT NULL,
      changelog         TEXT NOT NULL DEFAULT '[]',
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rss_seen (
      guid       TEXT PRIMARY KEY,
      first_seen INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS kv (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS logs (
      id    INTEGER PRIMARY KEY AUTOINCREMENT,
      ts    INTEGER NOT NULL,
      level TEXT NOT NULL,
      msg   TEXT NOT NULL,
      meta  TEXT
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Per-episode Plex metadata/thumbnail reconciliation state, keyed by the
    -- stable season/episode id (survives re-releases, unlike CRC32). desired_hash
    -- is what the dataset says we want; applied_hash is what we last pushed to
    -- Plex. desired != applied ⇒ needs a metadata sync. Lets a source refresh
    -- mark exactly the changed episodes dirty without touching Plex.
    CREATE TABLE IF NOT EXISTS plex_meta_state (
      season_episode_id TEXT PRIMARY KEY,
      arc_part          INTEGER NOT NULL,
      episode_num       INTEGER NOT NULL,
      desired_hash      TEXT,
      applied_hash      TEXT,
      in_plex           INTEGER NOT NULL DEFAULT 0,
      has_thumb         INTEGER NOT NULL DEFAULT 0,
      thumb_attempts    INTEGER NOT NULL DEFAULT 0,
      plex_title        TEXT,
      plex_rating_key   TEXT,
      last_scanned_at   INTEGER,
      last_synced_at    INTEGER
    );
  `);

  // Add columns introduced after initial release (no-op on fresh DBs).
  addColumnIfMissing(db, "episodes", "changelog", "TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing(db, "episodes", "extended", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "plex_meta_state", "thumb_last_attempt_at", "INTEGER");
  // Blank-thumbnail detection cache: which thumb version was pixel-analyzed and
  // whether it turned out to be a single-color (fade) frame.
  addColumnIfMissing(db, "plex_meta_state", "thumb_checked_path", "TEXT");
  addColumnIfMissing(db, "plex_meta_state", "thumb_blank", "INTEGER NOT NULL DEFAULT 0");
}

function addColumnIfMissing(
  db: Database.Database,
  table: string,
  column: string,
  definition: string
): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export function isGuidSeen(guid: string): boolean {
  const db = getDb();
  const row = db.prepare("SELECT 1 FROM rss_seen WHERE guid = ?").get(guid);
  return !!row;
}

export function markGuidSeen(guid: string): void {
  const db = getDb();
  db.prepare("INSERT OR IGNORE INTO rss_seen (guid, first_seen) VALUES (?, ?)").run(
    guid,
    Date.now()
  );
}

export function upsertEpisode(ep: Omit<EpisodeRecord, "created_at" | "updated_at">): void {
  const db = getDb();
  const now = Date.now();
  db.prepare(`
    INSERT INTO episodes (crc32, arc_num, arc_title, arc_part, episode_num, resolution,
      original_filename, final_filename, status, torrent_hash, magnet_uri, error_message,
      rss_guid, changelog, extended, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(crc32) DO UPDATE SET
      status = excluded.status,
      final_filename = excluded.final_filename,
      torrent_hash = excluded.torrent_hash,
      magnet_uri = COALESCE(excluded.magnet_uri, magnet_uri),
      error_message = excluded.error_message,
      changelog = excluded.changelog,
      extended = excluded.extended,
      updated_at = excluded.updated_at
  `).run(
    ep.crc32, ep.arc_num, ep.arc_title, ep.arc_part, ep.episode_num, ep.resolution,
    ep.original_filename, ep.final_filename, ep.status, ep.torrent_hash, ep.magnet_uri,
    ep.error_message, ep.rss_guid, JSON.stringify(ep.changelog ?? []), ep.extended ? 1 : 0, now, now
  );
}

export function updateEpisodeStatus(
  crc32: string,
  status: EpisodeStatus,
  patch: Partial<Pick<EpisodeRecord, "final_filename" | "torrent_hash" | "error_message">> = {}
): void {
  const db = getDb();
  db.prepare(`
    UPDATE episodes SET status = ?, final_filename = COALESCE(?, final_filename),
      torrent_hash = COALESCE(?, torrent_hash), error_message = ?,
      updated_at = ?
    WHERE crc32 = ?
  `).run(
    status, patch.final_filename ?? null, patch.torrent_hash ?? null,
    patch.error_message ?? null, Date.now(), crc32
  );
}

/** Updates only the stored final filename (e.g. after a normalize rename). */
export function setEpisodeFinalFilename(crc32: string, finalFilename: string): void {
  getDb()
    .prepare("UPDATE episodes SET final_filename = ?, updated_at = ? WHERE crc32 = ?")
    .run(finalFilename, Date.now(), crc32);
}

export function getEpisodesByStatus(status: EpisodeStatus): EpisodeRecord[] {
  return (getDb()
    .prepare("SELECT * FROM episodes WHERE status = ?")
    .all(status) as EpisodeRow[]).map(rowToRecord);
}

export function getEpisodeByCrc32(crc32: string): EpisodeRecord | null {
  const row = getDb().prepare("SELECT * FROM episodes WHERE crc32 = ?").get(crc32) as EpisodeRow | undefined;
  return row ? rowToRecord(row) : null;
}

export function deleteEpisode(crc32: string): void {
  getDb().prepare("DELETE FROM episodes WHERE crc32 = ?").run(crc32);
}

/** Removes all completed episodes from tracking. Returns the number cleared. */
export function clearDoneEpisodes(): number {
  return getDb().prepare("DELETE FROM episodes WHERE status = 'done'").run().changes;
}

export function listEpisodes(): EpisodeRecord[] {
  return (getDb()
    .prepare("SELECT * FROM episodes ORDER BY arc_part, episode_num")
    .all() as EpisodeRow[]).map(rowToRecord);
}

export function countByStatus(): Record<string, number> {
  const rows = getDb()
    .prepare("SELECT status, COUNT(*) AS n FROM episodes GROUP BY status")
    .all() as { status: string; n: number }[];
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

// Runtime setting overrides (dashboard-editable). Absence = use env/default.
export function getSettingOverride(key: string): string | null {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSettingOverride(key: string, value: string): void {
  getDb()
    .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, value);
}

export function deleteSettingOverride(key: string): void {
  getDb().prepare("DELETE FROM settings WHERE key = ?").run(key);
}

export function getKv(key: string): string | null {
  const row = getDb().prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setKv(key: string, value: string): void {
  getDb().prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

export interface LogRow {
  id: number;
  ts: number;
  level: string;
  msg: string;
  meta: string | null;
}

const LOG_RETENTION = 1000;

export function insertLog(entry: { ts: number; level: string; msg: string; meta?: unknown }): LogRow {
  const db = getDb();
  const metaStr = entry.meta ? JSON.stringify(entry.meta) : null;
  const info = db
    .prepare("INSERT INTO logs (ts, level, msg, meta) VALUES (?, ?, ?, ?)")
    .run(entry.ts, entry.level, entry.msg, metaStr);
  const id = Number(info.lastInsertRowid);
  // Prune to the newest LOG_RETENTION rows.
  db.prepare(
    "DELETE FROM logs WHERE id <= (SELECT MAX(id) FROM logs) - ?"
  ).run(LOG_RETENTION);
  return { id, ts: entry.ts, level: entry.level, msg: entry.msg, meta: metaStr };
}

export function getRecentLogs(limit = 200): LogRow[] {
  const n = Math.max(1, Math.min(limit, LOG_RETENTION));
  const rows = getDb()
    .prepare("SELECT * FROM logs ORDER BY id DESC LIMIT ?")
    .all(n) as LogRow[];
  return rows.reverse(); // chronological order for display
}

export function getEpisodeByTorrentHash(hash: string): EpisodeRecord | null {
  const row = getDb()
    .prepare("SELECT * FROM episodes WHERE torrent_hash = ?")
    .get(hash) as EpisodeRow | undefined;
  return row ? rowToRecord(row) : null;
}

// ── Plex metadata/thumbnail reconciliation state ────────────────────────────

export interface MetaStateRow {
  season_episode_id: string;
  arc_part: number;
  episode_num: number;
  desired_hash: string | null;
  applied_hash: string | null;
  in_plex: number;
  has_thumb: number;
  thumb_attempts: number;
  thumb_last_attempt_at: number | null;
  thumb_checked_path: string | null;
  thumb_blank: number;
  plex_title: string | null;
  plex_rating_key: string | null;
  last_scanned_at: number | null;
  last_synced_at: number | null;
}

export function getAllMetaStates(): MetaStateRow[] {
  return getDb().prepare("SELECT * FROM plex_meta_state").all() as MetaStateRow[];
}

export function getMetaState(id: string): MetaStateRow | null {
  return (getDb()
    .prepare("SELECT * FROM plex_meta_state WHERE season_episode_id = ?")
    .get(id) as MetaStateRow | undefined) ?? null;
}

/**
 * Sets the desired-state hash for an episode (what the dataset says we want),
 * inserting the row if it's new. Leaves applied_hash and Plex-observed fields
 * untouched — a bare source-refresh update that never needs a Plex round-trip.
 */
export function setDesiredMeta(id: string, arcPart: number, episodeNum: number, desiredHash: string): void {
  getDb().prepare(`
    INSERT INTO plex_meta_state (season_episode_id, arc_part, episode_num, desired_hash)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(season_episode_id) DO UPDATE SET
      desired_hash = excluded.desired_hash,
      arc_part = excluded.arc_part,
      episode_num = excluded.episode_num
  `).run(id, arcPart, episodeNum, desiredHash);
}

/** Records what Plex currently reports for an episode (from a scan). */
export function setObservedMeta(
  id: string,
  obs: { inPlex: boolean; hasThumb: boolean; plexTitle: string | null; ratingKey: string | null }
): void {
  getDb().prepare(`
    UPDATE plex_meta_state SET
      in_plex = ?, has_thumb = ?, plex_title = ?, plex_rating_key = ?, last_scanned_at = ?
    WHERE season_episode_id = ?
  `).run(obs.inPlex ? 1 : 0, obs.hasThumb ? 1 : 0, obs.plexTitle, obs.ratingKey, Date.now(), id);
}

/** Marks an episode's metadata as successfully applied to Plex. */
export function setAppliedMeta(id: string, appliedHash: string): void {
  getDb().prepare(`
    UPDATE plex_meta_state SET applied_hash = ?, last_synced_at = ? WHERE season_episode_id = ?
  `).run(appliedHash, Date.now(), id);
}

/** Bumps the thumbnail-generation attempt counter after a refresh/analyze. */
export function bumpThumbAttempt(id: string): void {
  getDb()
    .prepare("UPDATE plex_meta_state SET thumb_attempts = thumb_attempts + 1, thumb_last_attempt_at = ? WHERE season_episode_id = ?")
    .run(Date.now(), id);
}

/** Clears the thumbnail attempt counter once a thumb is observed present. */
export function resetThumbAttempts(id: string): void {
  getDb()
    .prepare("UPDATE plex_meta_state SET thumb_attempts = 0, thumb_last_attempt_at = NULL WHERE season_episode_id = ?")
    .run(id);
}

/**
 * Resets every episode's thumbnail attempt counter and clears the blank-frame
 * analysis cache — a manual "try again" that also forces re-analysis of thumbs.
 */
export function resetAllThumbAttempts(): number {
  return getDb()
    .prepare("UPDATE plex_meta_state SET thumb_attempts = 0, thumb_last_attempt_at = NULL, thumb_checked_path = NULL, thumb_blank = 0 WHERE thumb_attempts > 0 OR thumb_checked_path IS NOT NULL")
    .run().changes;
}

/** Records the blank-analysis verdict for a specific thumb version. */
export function setThumbCheck(id: string, path: string, blank: boolean): void {
  getDb()
    .prepare("UPDATE plex_meta_state SET thumb_checked_path = ?, thumb_blank = ? WHERE season_episode_id = ?")
    .run(path, blank ? 1 : 0, id);
}
