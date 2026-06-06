export interface Episode {
  crc32: string;
  arc_part: number;
  episode_num: number;
  arc_title: string;
  status: string;
  resolution: string;
  final_filename: string | null;
  original_filename: string | null;
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
