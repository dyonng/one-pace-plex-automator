import { writable } from "svelte/store";
import {
  fetchStatus,
  fetchLogs,
  fetchSettings,
  fetchAuth,
  fetchCoverage,
  scanCoverageReq,
  fetchHealth,
  runHealthCheckReq,
  episodeAction,
  type Status,
  type LogEntry,
  type SettingView,
  type AuthState,
  type CoverageReport,
  type HealthReport,
} from "./api";

export const status = writable<Status | null>(null);
export const logs = writable<LogEntry[]>([]);
export const settings = writable<SettingView[]>([]);
export const auth = writable<AuthState | null>(null);
export const coverage = writable<CoverageReport | null>(null);
export const coverageLoading = writable(false);
export const health = writable<HealthReport | null>(null);
export const healthLoading = writable(false);
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

export async function doEpisodeAction(
  crc32: string,
  action: "download" | "retry" | "resync" | "remove",
  body?: Record<string, unknown>
): Promise<{ ok: boolean; message: string }> {
  let r: { ok: boolean; message: string };
  try {
    r = await episodeAction(crc32, action, body);
  } catch {
    r = { ok: false, message: "Request failed" };
  }
  toast(r.message, r.ok);
  await refreshStatus();
  return r;
}

export async function loadSettings(): Promise<void> {
  try {
    settings.set(await fetchSettings());
  } catch {
    /* ignore */
  }
}

/** Load the last health snapshot from the poller (cheap; safe to call often). */
export async function refreshHealth(): Promise<void> {
  try {
    health.set(await fetchHealth());
  } catch {
    /* transient — keep last snapshot */
  }
}

/** Force an immediate health re-check (the "Check now" button). */
export async function runHealthCheck(): Promise<void> {
  healthLoading.set(true);
  try {
    health.set(await runHealthCheckReq());
  } catch {
    toast("Health check failed", false);
  } finally {
    healthLoading.set(false);
  }
}

/** Load the last stored scan (e.g. on mount). No-ops quietly if none exists. */
export async function loadCoverage(): Promise<void> {
  try {
    coverage.set(await fetchCoverage());
  } catch {
    /* ignore — leave coverage null */
  }
}

/** Trigger a fresh disk scan and store the result. */
export async function runCoverageScan(): Promise<void> {
  coverageLoading.set(true);
  try {
    coverage.set(await scanCoverageReq());
  } catch {
    toast("Coverage scan failed", false);
  } finally {
    coverageLoading.set(false);
  }
}

export async function loadAuth(): Promise<void> {
  try {
    auth.set(await fetchAuth());
  } catch {
    /* ignore */
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
  refreshHealth();
  return setInterval(() => {
    refreshStatus();
    refreshHealth();
  }, 5000);
}
