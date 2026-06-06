import { writable } from "svelte/store";
import { fetchStatus, fetchLogs, type Status, type LogEntry } from "./api";

export const status = writable<Status | null>(null);
export const logs = writable<LogEntry[]>([]);
export const toasts = writable<{ id: number; ok: boolean; msg: string }[]>([]);

let _toastId = 0;
export function toast(msg: string, ok: boolean): void {
  const id = ++_toastId;
  toasts.update((t) => [...t, { id, ok, msg }]);
  setTimeout(() => toasts.update((t) => t.filter((x) => x.id !== id)), 4000);
}

export async function refreshStatus(): Promise<void> {
  try {
    status.set(await fetchStatus());
  } catch {
    /* transient — keep last status */
  }
}

export async function initLogs(): Promise<void> {
  try {
    logs.set(await fetchLogs());
  } catch {
    /* ignore */
  }
}

export function streamLogs(): EventSource {
  const es = new EventSource("/api/logs/stream");
  es.onmessage = (ev) => {
    try {
      const e = JSON.parse(ev.data) as LogEntry;
      logs.update((l) => {
        const next = [...l, e];
        return next.length > 1000 ? next.slice(next.length - 1000) : next;
      });
    } catch {
      /* ignore malformed line */
    }
  };
  return es;
}

export function startPolling(): ReturnType<typeof setInterval> {
  refreshStatus();
  return setInterval(refreshStatus, 5000);
}
