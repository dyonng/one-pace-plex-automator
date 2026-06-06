import { runCycle, dispatchPending } from "./cycle";
import { runMetadataSync, retryFailed } from "./processor";
import { refreshMetadata, clearMetadataCache } from "./metadata";

export interface Runtime {
  startedAt: number;
  lastPollAt: number | null;
  lastSyncAt: number | null;
  lastRefreshAt: number | null;
  lastRetryAt: number | null;
}

export const runtime: Runtime = {
  startedAt: Date.now(),
  lastPollAt: null,
  lastSyncAt: null,
  lastRefreshAt: null,
  lastRetryAt: null,
};

// Serialize actions so a manual trigger never overlaps the cron cycle or another
// manual trigger (they share qBit/Plex/DB state).
let _running = false;
let _runningLabel: string | null = null;

export function isBusy(): boolean {
  return _running;
}

export function busyLabel(): string | null {
  return _runningLabel;
}

async function withLock<T>(label: string, fn: () => Promise<T>): Promise<T> {
  if (_running) throw new Error(`Busy: "${_runningLabel}" is already running`);
  _running = true;
  _runningLabel = label;
  try {
    return await fn();
  } finally {
    _running = false;
    _runningLabel = null;
  }
}

export type ActionId = "poll" | "sync" | "refresh-metadata" | "retry-failed";

export interface ActionResult {
  ok: boolean;
  message: string;
}

export async function runAction(id: ActionId): Promise<ActionResult> {
  switch (id) {
    case "poll":
      return withLock("Poll RSS", async () => {
        await runCycle();
        runtime.lastPollAt = Date.now();
        return { ok: true, message: "RSS poll cycle complete" };
      });

    case "sync":
      return withLock("Full Plex sync", async () => {
        await runMetadataSync();
        runtime.lastSyncAt = Date.now();
        return { ok: true, message: "Full Plex metadata sync complete" };
      });

    case "refresh-metadata":
      return withLock("Refresh metadata", async () => {
        clearMetadataCache();
        await refreshMetadata();
        runtime.lastRefreshAt = Date.now();
        return { ok: true, message: "Metadata cache refreshed" };
      });

    case "retry-failed":
      return withLock("Retry failed", async () => {
        await retryFailed();
        await dispatchPending();
        runtime.lastRetryAt = Date.now();
        return { ok: true, message: "Failed episodes re-queued" };
      });

    default:
      throw new Error(`Unknown action: ${id}`);
  }
}
