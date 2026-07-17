import { writable, get } from "svelte/store";
import {
  fetchStatus,
  fetchLogs,
  fetchSettings,
  fetchAuth,
  fetchCoverage,
  scanCoverageReq,
  fetchMetadataAudit,
  scanMetadataAuditReq,
  fetchHealth,
  runHealthCheckReq,
  episodeAction,
  fetchDownloadProgress,
  type Status,
  type LogEntry,
  type SettingView,
  type AuthState,
  type CoverageReport,
  type MetadataAuditReport,
  type HealthReport,
  type TorrentProgress,
} from "./api";

export const status = writable<Status | null>(null);
export const logs = writable<LogEntry[]>([]);
export function clearLogs(): void { logs.set([]); }
export const settings = writable<SettingView[]>([]);
export const auth = writable<AuthState | null>(null);
export const coverage = writable<CoverageReport | null>(null);
export const coverageLoading = writable(false);
export const metadataAudit = writable<MetadataAuditReport | null>(null);
export const metadataAuditLoading = writable(false);
export const health = writable<HealthReport | null>(null);
export const healthLoading = writable(false);
export const toasts = writable<{ id: number; ok: boolean; msg: string }[]>([]);
export const downloadProgress = writable<Record<string, TorrentProgress>>({});
export const settingsOpen = writable(false);

let _toastId = 0;
export function toast(msg: string, ok: boolean): void {
  const id = ++_toastId;
  toasts.update((t) => [...t, { id, ok, msg }]);
  setTimeout(() => toasts.update((t) => t.filter((x) => x.id !== id)), 4000);
}

// The server stamps a fresh `runtime.startedAt` every boot. We remember the
// first one we see; if a later poll reports a different value the server was
// restarted (e.g. a redeploy), so reload the page — that reconnects the SSE
// stream and pulls the freshly built UI bundle (its asset hash changes).
let seenStartedAt: number | null = null;
let lastCoverageScannedAt: number | null = null;
let lastMetadataAuditScannedAt: number | null = null;

export async function refreshStatus(): Promise<void> {
  try {
    const s = await fetchStatus();
    const started = s.runtime?.startedAt ?? null;
    if (started != null) {
      if (seenStartedAt == null) {
        seenStartedAt = started;
      } else if (started !== seenStartedAt && typeof location !== "undefined") {
        location.reload();
        return;
      }
    }
    status.set(s);

    // The backend re-scans coverage after ingesting an episode (and on RSS
    // changes). When its report timestamp advances, pull the fresh report so
    // the Coverage section updates on its own — but only if one is loaded.
    const scannedAt = s.coverageScannedAt ?? null;
    if (
      scannedAt !== null &&
      lastCoverageScannedAt !== null &&
      scannedAt !== lastCoverageScannedAt &&
      get(coverage) !== null
    ) {
      loadCoverage();
    }
    lastCoverageScannedAt = scannedAt;

    // Same freshness trick for the metadata audit: a sync re-audits on the
    // server, so pull the fresh report when its timestamp advances.
    const auditAt = s.metadataAuditScannedAt ?? null;
    if (
      auditAt !== null &&
      lastMetadataAuditScannedAt !== null &&
      auditAt !== lastMetadataAuditScannedAt &&
      get(metadataAudit) !== null
    ) {
      loadMetadataAudit();
    }
    lastMetadataAuditScannedAt = auditAt;
  } catch {
    /* transient — keep last status */
  }
}

export async function doEpisodeAction(
  crc32: string,
  action: "download" | "retry" | "resync" | "remove" | "upgrade" | "download-source",
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

/** Load the last stored metadata audit (e.g. on mount). No-ops if none exists. */
export async function loadMetadataAudit(): Promise<void> {
  try {
    metadataAudit.set(await fetchMetadataAudit());
  } catch {
    /* ignore — leave audit null */
  }
}

/** Trigger a fresh metadata audit against Plex and store the result. */
export async function runMetadataAuditScan(): Promise<void> {
  metadataAuditLoading.set(true);
  try {
    metadataAudit.set(await scanMetadataAuditReq());
  } catch {
    toast("Metadata audit failed", false);
  } finally {
    metadataAuditLoading.set(false);
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

export function startProgressPolling(): ReturnType<typeof setInterval> {
  return setInterval(async () => {
    const s = get(status);
    if (!s?.episodes.some(e => e.status === "downloading")) {
      if (Object.keys(get(downloadProgress)).length) downloadProgress.set({});
      return;
    }
    try {
      downloadProgress.set(await fetchDownloadProgress());
    } catch { /* transient — keep last value */ }
  }, 2000);
}

export function startPolling(): ReturnType<typeof setInterval> {
  refreshStatus();
  refreshHealth();
  return setInterval(() => {
    refreshStatus();
    refreshHealth();
  }, 5000);
}
