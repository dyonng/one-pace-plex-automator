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

// Fire a Discord alert only when the overall status *changes* (into or out of a
// degraded state) — not every check — so a steady problem doesn't spam. The very
// first run just seeds the baseline; boot-time flapping is swallowed by the grace
// window.
async function maybeSendHealthAlert(report: HealthReport): Promise<void> {
  const prev = getKv(KV_ALERT_STATUS);
  const overall = report.overall;
  if (!prev) {
    setKv(KV_ALERT_STATUS, overall);
    return;
  }
  if (overall === prev) return;
  setKv(KV_ALERT_STATUS, overall);
  if (Date.now() - _startedAt < HEALTH_ALERT_GRACE_MS) return;
  await sendDiscordHealthAlert({ status: overall, lines: overall === "ok" ? [] : failingLines(report) });
}

export async function runHealthCheck(): Promise<HealthReport> {
  const [plex, qbit, rss] = await Promise.all([
    timed("Plex", async () => {
      await pingPlex();
      return "reachable";
    }),
    timed("qBittorrent", async () => `v${await getQbitClient().ping()}`),
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
