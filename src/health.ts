import fs from "fs";
import { MEDIA_PATH, DOWNLOAD_PATH } from "./constants";
import { logger } from "./logger";
import { getKv, setKv, countByStatus } from "./db";
import { getSettingValue } from "./settings";
import { pingPlex } from "./plex";
import { getQbitClient } from "./qbittorrent";
import { isMetadataLoaded } from "./metadata";
import { runtime } from "./controls";
import { sendDiscordHealthAlert } from "./discord";

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

const KV_KEY = "health_report";
// Last overall status we've alerted from — the baseline for detecting a change.
const KV_ALERT_STATUS = "health_alert_status";
// Suppress alerts for the first couple of minutes after boot, while metadata
// loads and Plex/qBittorrent connections warm up (otherwise every restart would
// fire a transient "warn").
const HEALTH_ALERT_GRACE_MS = 2 * 60 * 1000;
// A status must hold across this many consecutive checks before it can alert —
// debounces transient blips (a slow check, a dataset re-fetch) that clear within
// a minute so they never reach Discord.
const ALERT_CONFIRM_COUNT = 2;
const GB = 1024 ** 3;
const SEVERITY: Record<HealthStatus, number> = { ok: 0, warn: 1, error: 2 };

const worst = (statuses: HealthStatus[]): HealthStatus =>
  statuses.reduce<HealthStatus>((acc, s) => (SEVERITY[s] > SEVERITY[acc] ? s : acc), "ok");

async function timed(
  name: string,
  fn: () => Promise<string>
): Promise<HealthCheck> {
  const start = Date.now();
  try {
    const detail = await fn();
    return { name, status: "ok", detail, latencyMs: Date.now() - start };
  } catch (err) {
    return { name, status: "error", detail: (err as Error).message, latencyMs: Date.now() - start };
  }
}

async function checkRss(): Promise<HealthCheck> {
  return timed("RSS feed", async () => {
    const url = getSettingValue("RSS_FEED_URL");
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return "reachable";
  });
}

function checkMetadata(): HealthCheck {
  return isMetadataLoaded()
    ? { name: "Metadata", status: "ok", detail: "dataset loaded", latencyMs: null }
    : { name: "Metadata", status: "warn", detail: "dataset not loaded yet", latencyMs: null };
}

function checkDisk(name: string, path: string): DiskInfo {
  try {
    const s = fs.statfsSync(path);
    const freeBytes = s.bavail * s.bsize;
    const totalBytes = s.blocks * s.bsize;
    const freePct = totalBytes > 0 ? (freeBytes / totalBytes) * 100 : 0;
    let status: HealthStatus = "ok";
    if (freeBytes < 1 * GB) status = "error";
    else if (freeBytes < 5 * GB || freePct < 5) status = "warn";
    return { name, path, status, freeBytes, totalBytes, freePct };
  } catch {
    // Path missing or filesystem doesn't support statfs — surface as a warning.
    return { name, path, status: "warn", freeBytes: 0, totalBytes: 0, freePct: 0 };
  }
}

// One line per failing check/disk, plus the failed-item count, for the alert body.
function failingLines(report: HealthReport): string[] {
  const lines: string[] = [];
  for (const c of report.checks) if (c.status !== "ok") lines.push(`${c.name}: ${c.detail}`);
  for (const d of report.disks) if (d.status !== "ok") lines.push(`${d.name} disk: ${d.freePct.toFixed(1)}% free`);
  if (report.failedCount > 0) lines.push(`${report.failedCount} failed item(s) in the pipeline`);
  return lines;
}

export interface AlertState {
  baseline: HealthStatus | null; // last confirmed status we alert changes from (null = not seeded)
  candidate: HealthStatus | null; // the status currently being confirmed
  count: number; // consecutive observations of `candidate`
}

/**
 * Pure transition for the health-alert state machine. A status must be observed
 * `confirm` times in a row to be "confirmed"; only then can it move the baseline
 * and emit. The first confirmation just seeds the baseline (no alert). `emit` is
 * the status to announce, or null for "do nothing". Grace/recovery-gating is the
 * caller's job — this stays pure and testable.
 */
export function nextAlertState(
  prev: AlertState,
  overall: HealthStatus,
  confirm: number
): { state: AlertState; emit: HealthStatus | null } {
  const candidate = overall === prev.candidate ? prev.candidate : overall;
  const count = overall === prev.candidate ? prev.count + 1 : 1;
  if (count < confirm) return { state: { ...prev, candidate, count }, emit: null };
  if (prev.baseline === null) return { state: { baseline: overall, candidate, count }, emit: null };
  if (overall === prev.baseline) return { state: { ...prev, candidate, count }, emit: null };
  return { state: { baseline: overall, candidate, count }, emit: overall };
}

let _alert: AlertState = { baseline: null, candidate: null, count: 0 };
// Whether a problem alert is currently outstanding — gates recovery so we never
// send a lone "recovered" for a blip that was itself suppressed (grace/debounce).
let _problemActive = false;

// Fire a Discord alert only when the overall status changes into or out of a
// degraded state, confirmed across consecutive checks — so steady state, single
// blips, and boot-time flapping never spam.
async function maybeSendHealthAlert(report: HealthReport): Promise<void> {
  // Adopt any persisted baseline (survives restarts) before the first decision.
  if (_alert.baseline === null) {
    const persisted = getKv(KV_ALERT_STATUS);
    if (persisted === "ok" || persisted === "warn" || persisted === "error") _alert.baseline = persisted;
  }

  const { state, emit } = nextAlertState(_alert, report.overall, ALERT_CONFIRM_COUNT);
  _alert = state;
  if (state.baseline) setKv(KV_ALERT_STATUS, state.baseline);
  if (!emit) return;

  if (emit === "ok") {
    if (!_problemActive) return; // nothing was announced → don't send a lone recovery
    _problemActive = false;
    await sendDiscordHealthAlert({ status: "ok", lines: [] });
    return;
  }

  // Problem (warn/error): suppress while still inside the boot grace window.
  if (Date.now() - _startedAt < HEALTH_ALERT_GRACE_MS) return;
  _problemActive = true;
  await sendDiscordHealthAlert({ status: emit, lines: failingLines(report) });
}

export async function runHealthCheck(): Promise<HealthReport> {
  const [plex, qbit, rss] = await Promise.all([
    timed("Plex", async () => {
      await pingPlex();
      return "reachable";
    }),
    // qBittorrent's /app/version already includes a leading "v" — normalize so
    // we don't end up with "vv5.2.3".
    timed("qBittorrent", async () => `v${(await getQbitClient().ping()).replace(/^v/i, "")}`),
    checkRss(),
  ]);
  const metadata = checkMetadata();

  const disks = [
    checkDisk("Media", MEDIA_PATH),
    checkDisk("Downloads", DOWNLOAD_PATH),
  ];

  const failedCount = countByStatus().failed ?? 0;

  // Failures aren't shown as a separate check (the pipeline counts already
  // surface them) but still drag the overall status to "warn".
  const checks = [plex, qbit, rss, metadata];
  const overall = worst([
    ...checks.map((c) => c.status),
    ...disks.map((d) => d.status),
    failedCount > 0 ? "warn" : "ok",
  ]);

  const lastPollAt = runtime.lastPollAt;
  const report: HealthReport = {
    checkedAt: Date.now(),
    overall,
    checks,
    disks,
    lastPollAt,
    lastPollAgoSec: lastPollAt ? Math.floor((Date.now() - lastPollAt) / 1000) : null,
    failedCount,
  };

  setKv(KV_KEY, JSON.stringify(report));
  try {
    await maybeSendHealthAlert(report);
  } catch (err) {
    logger.warn("Health alert dispatch failed", { error: (err as Error).message });
  }
  return report;
}

export function getStoredHealth(): HealthReport | null {
  const raw = getKv(KV_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as HealthReport;
  } catch {
    return null;
  }
}

let _timer: ReturnType<typeof setInterval> | null = null;
// When the monitor started — anchors the alert grace window (see HEALTH_ALERT_GRACE_MS).
let _startedAt = 0;

export function startHealthMonitor(intervalMs = 60_000): void {
  _startedAt = Date.now();
  // Run once immediately so the dashboard has data right after boot.
  runHealthCheck().catch((err) => logger.warn("Health check failed", { error: (err as Error).message }));
  _timer = setInterval(() => {
    runHealthCheck().catch((err) => logger.warn("Health check failed", { error: (err as Error).message }));
  }, intervalMs);
  if (_timer.unref) _timer.unref();
  logger.info("Health monitor started", { intervalMs });
}

export function stopHealthMonitor(): void {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}
