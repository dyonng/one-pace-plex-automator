export const fmtTime = (ts: number | null | undefined): string =>
  ts ? new Date(ts).toLocaleString() : "—";

export function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return (d ? `${d}d ` : "") + (h ? `${h}h ` : "") + (m ? `${m}m ` : "") + `${s}s`;
}

export const STATUS_BADGE: Record<string, string> = {
  pending: "badge-neutral",
  downloading: "badge-info",
  processing: "badge-warning",
  done: "badge-success",
  failed: "badge-error",
};

export const LEVEL_CLASS: Record<string, string> = {
  debug: "opacity-60",
  info: "text-info",
  warn: "text-warning",
  error: "text-error",
};
