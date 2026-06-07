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
  action: "download" | "retry" | "resync" | "remove",
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
