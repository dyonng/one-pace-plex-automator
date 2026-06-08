export interface Episode {
  crc32: string;
  arc_part: number;
  episode_num: number;
  arc_title: string;
  status: string;
  resolution: string;
  final_filename: string | null;
  original_filename: string | null;
  changelog: string[];
  error_message: string | null;
  file_size: number | null;
  created_at: number;
  updated_at: number;
}

export interface Status {
  version: string;
  uptimeSec: number;
  busy: boolean;
  busyLabel: string | null;
  schedule: { pollCron: string; downloadCheck: string };
  runtime: {
    startedAt: number;
    lastPollAt: number | null;
    lastSyncAt: number | null;
    lastRefreshAt: number | null;
    lastRetryAt: number | null;
  };
  metadata: { arcs: number; episodes: number } | null;
  plex: { plexUrl: string; libraryName: string; showTitle: string } | null;
  config: {
    rssFeedUrl: string;
    qbitUrl: string;
    qbitCategory: string;
    plexLibraryName: string;
    discordConfigured: boolean;
  };
  counts: Record<string, number>;
  episodes: Episode[];
}

export interface LogEntry {
  ts: number;
  level: string;
  msg: string;
  meta?: unknown;
}

interface LogRow {
  ts: number;
  level: string;
  msg: string;
  meta: string | null;
}

export async function fetchStatus(): Promise<Status> {
  const r = await fetch("/api/status");
  if (!r.ok) throw new Error("status " + r.status);
  return r.json();
}

export async function fetchLogs(): Promise<LogEntry[]> {
  const r = await fetch("/api/logs");
  if (!r.ok) throw new Error("logs " + r.status);
  const rows: LogRow[] = await r.json();
  return rows.map((row) => ({
    ts: row.ts,
    level: row.level,
    msg: row.msg,
    meta: row.meta ? JSON.parse(row.meta) : undefined,
  }));
}

export async function postAction(id: string): Promise<{ ok: boolean; message: string }> {
  const r = await fetch("/api/actions/" + id, { method: "POST" });
  return r.json();
}

export async function episodeAction(
  crc32: string,
  action: "download" | "retry" | "resync" | "remove" | "upgrade",
  body?: Record<string, unknown>
): Promise<{ ok: boolean; message: string }> {
  const r = await fetch(`/api/episodes/${crc32}/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
}

export interface SettingView {
  key: string;
  label: string;
  type: string;
  value: string;
  envValue: string;
  overridden: boolean;
}

export async function fetchSettings(): Promise<SettingView[]> {
  const r = await fetch("/api/settings");
  if (!r.ok) throw new Error("settings " + r.status);
  return r.json();
}

export async function saveSetting(key: string, value: string): Promise<{ ok: boolean; message: string }> {
  const r = await fetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, value }),
  });
  return r.json();
}

export async function resetSettingReq(key: string): Promise<{ ok: boolean; message: string }> {
  const r = await fetch("/api/settings/reset", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key }),
  });
  return r.json();
}

export async function testDiscordReq(): Promise<{ ok: boolean; message: string }> {
  const r = await fetch("/api/discord/test", { method: "POST" });
  return r.json();
}

export type HealthStatus = "ok" | "warn" | "error";

export interface HealthCheck {
  name: string;
  status: HealthStatus;
  detail: string;
  latencyMs: number | null;
}

export interface DiskInfo {
  name: string;
  path: string;
  status: HealthStatus;
  freeBytes: number;
  totalBytes: number;
  freePct: number;
}

export interface HealthReport {
  checkedAt: number;
  overall: HealthStatus;
  checks: HealthCheck[];
  disks: DiskInfo[];
  lastPollAt: number | null;
  lastPollAgoSec: number | null;
  failedCount: number;
}

export async function fetchHealth(): Promise<HealthReport | null> {
  const r = await fetch("/api/health/full");
  if (!r.ok) throw new Error("health " + r.status);
  return r.json();
}

export async function runHealthCheckReq(): Promise<HealthReport> {
  const r = await fetch("/api/health/check", { method: "POST" });
  if (!r.ok) throw new Error("health check " + r.status);
  return r.json();
}

export type CoverageStatus = "present" | "present_unknown" | "upgradeable" | "missing";

export interface CoverageEpisode {
  arcPart: number;
  episodeNum: number;
  seasonEpisodeId: string;
  episodeTitle: string;
  datasetCrc32: string;
  status: CoverageStatus;
  diskFilename: string | null;
  diskCrc32: string | null;
  hasMagnet: boolean;
  extended: boolean;
}

export interface CoverageArc {
  arcPart: number;
  arcTitle: string;
  arcSaga: string;
  total: number;
  present: number;
  missing: number;
  upgradeable: number;
  seasonFolder: string | null;
  episodes: CoverageEpisode[];
}

export interface CoverageReport {
  scannedAt: number;
  mediaPath: string;
  mediaPathExists: boolean;
  totals: { episodes: number; present: number; missing: number; upgradeable: number };
  arcs: CoverageArc[];
  extras: string[];
}

export interface TorrentProgress {
  progress: number; // 0–1
  dlspeed: number;  // bytes/s
  eta: number;      // seconds remaining, -1 if unknown
  state: string;
}

export async function fetchDownloadProgress(): Promise<Record<string, TorrentProgress>> {
  const r = await fetch("/api/downloads/progress");
  if (!r.ok) throw new Error("progress " + r.status);
  return r.json();
}

export interface EpisodeMetadata {
  crc32: string;
  arcTitle: string;
  arcPart: number;
  episodeNum: number;
  episodeTitle: string;
  episodeDescription: string;
  chapters: string;
  originalEpisodes: string;
  released: string;
  extended: boolean;
}

export async function fetchEpisodeMetadata(crc32: string): Promise<EpisodeMetadata | null> {
  const r = await fetch(`/api/metadata/${encodeURIComponent(crc32)}`);
  if (!r.ok) return null;
  return r.json();
}

/** Last stored scan, or null if none has run yet. */
export async function fetchCoverage(): Promise<CoverageReport | null> {
  const r = await fetch("/api/coverage");
  if (!r.ok) throw new Error("coverage " + r.status);
  return r.json();
}

/** Runs a fresh disk scan, overwrites the stored report, returns it. */
export async function scanCoverageReq(): Promise<CoverageReport> {
  const r = await fetch("/api/coverage/scan", { method: "POST" });
  if (!r.ok) throw new Error("coverage scan " + r.status);
  return r.json();
}

export interface AuthState {
  enabled: boolean;
  hasPassword: boolean;
}

export async function fetchAuth(): Promise<AuthState> {
  const r = await fetch("/api/auth");
  if (!r.ok) throw new Error("auth " + r.status);
  return r.json();
}

export async function setAuthPassword(password: string): Promise<{ ok: boolean; message: string }> {
  const r = await fetch("/api/auth/password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  return r.json();
}

export async function toggleAuth(enabled: boolean): Promise<{ ok: boolean; message: string }> {
  const r = await fetch("/api/auth/toggle", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  return r.json();
}
