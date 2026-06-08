import cronstrue from "cronstrue";

export const fmtTime = (ts: number | null | undefined): string =>
  ts ? new Date(ts).toLocaleString() : "—";

/** Human-readable cron, e.g. "0 0 * * *" -> "At 12:00 AM". Falls back gracefully. */
export function humanCron(expr: string | null | undefined): string {
  if (!expr) return "—";
  try {
    return cronstrue.toString(expr.trim());
  } catch {
    return "invalid cron";
  }
}

export function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return (d ? `${d}d ` : "") + (h ? `${h}h ` : "") + (m ? `${m}m ` : "") + `${s}s`;
}

export function fmtBytes(n: number): string {
  if (!n) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

export function fmtSpeed(bps: number): string {
  if (!bps) return "—";
  return `${fmtBytes(bps)}/s`;
}

export function fmtEta(sec: number): string {
  if (sec < 0 || sec >= 8_640_000) return "—";
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
}

export const STATUS_BADGE: Record<string, string> = {
  available: "badge-accent",
  pending: "badge-neutral",
  downloading: "badge-info",
  processing: "badge-warning",
  done: "badge-success",
  failed: "badge-error",
};

export const STATUS_ORDER = ["available", "pending", "downloading", "processing", "done", "failed"];

export const LEVEL_CLASS: Record<string, string> = {
  debug: "opacity-60",
  info: "text-info",
  warn: "text-warning",
  error: "text-error",
};
