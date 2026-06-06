import Database from "better-sqlite3";
import path from "path";
import { DATA_DIR } from "./constants";

export type EpisodeStatus =
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
  created_at: number;
  updated_at: number;
}

// Raw row as stored in SQLite: changelog is a JSON-encoded string.
type EpisodeRow = Omit<EpisodeRecord, "changelog"> & { changelog: string };

function rowToRecord(row: EpisodeRow): EpisodeRecord {
  let changelog: string[] = [];
  try {
    changelog = JSON.parse(row.changelog ?? "[]");
  } catch {
    changelog = [];
  }
  return { ...row, changelog };
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
  `);

  // Add columns introduced after initial release (no-op on fresh DBs).
  addColumnIfMissing(db, "episodes", "changelog", "TEXT NOT NULL DEFAULT '[]'");
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
      rss_guid, changelog, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(crc32) DO UPDATE SET
      status = excluded.status,
      final_filename = excluded.final_filename,
      torrent_hash = excluded.torrent_hash,
      magnet_uri = COALESCE(excluded.magnet_uri, magnet_uri),
      error_message = excluded.error_message,
      changelog = excluded.changelog,
      updated_at = excluded.updated_at
  `).run(
    ep.crc32, ep.arc_num, ep.arc_title, ep.arc_part, ep.episode_num, ep.resolution,
    ep.original_filename, ep.final_filename, ep.status, ep.torrent_hash, ep.magnet_uri,
    ep.error_message, ep.rss_guid, JSON.stringify(ep.changelog ?? []), now, now
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

export function getEpisodesByStatus(status: EpisodeStatus): EpisodeRecord[] {
  return (getDb()
    .prepare("SELECT * FROM episodes WHERE status = ?")
    .all(status) as EpisodeRow[]).map(rowToRecord);
}

export function getEpisodeByCrc32(crc32: string): EpisodeRecord | null {
  const row = getDb().prepare("SELECT * FROM episodes WHERE crc32 = ?").get(crc32) as EpisodeRow | undefined;
  return row ? rowToRecord(row) : null;
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
