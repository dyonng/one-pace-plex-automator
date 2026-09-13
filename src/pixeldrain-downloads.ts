import fs from "fs";
import path from "path";
import { DOWNLOAD_PATH } from "./constants";
import { logger } from "./logger";
import { recordDownloadProgress, setDownloadVia, updateEpisodeStatus, type EpisodeRecord } from "./db";
import { downloadFile, getFileInfo, getLimits, limitsAllow, partPathFor } from "./pixeldrain";

/**
 * Orchestrates direct HTTPS downloads from Pixeldrain alongside the torrent
 * pipeline. The two are deliberately independent failure domains: a dead VPN
 * port-forward leaves torrents at `stalledDL` forever, while an HTTPS GET is
 * unaffected — and vice versa when Pixeldrain rate-limits.
 *
 * Completion is detected from the filesystem, not from memory: a transfer writes
 * to `<name>.part` and renames on success, so a restart mid-download resumes
 * from the bytes already on disk rather than starting over.
 */

// Enough to keep the pipe busy without hammering a service that is doing us a
// favour. Episodes are ~1GB, and at the observed throughput two at a time
// saturates most home connections anyway.
const MAX_CONCURRENT = 2;

// Consecutive transfer failures before an episode is handed to the torrent path.
// Transient network faults are common on a 1GB download; a link that is actually
// broken fails the same way every time and shouldn't be retried indefinitely.
const MAX_TRANSFER_FAILURES = 3;

interface ActiveTransfer {
  crc32: string;
  controller: AbortController;
  startedAt: number;
}

const _active = new Map<string, ActiveTransfer>();
const _failures = new Map<string, number>();

export function activeCount(): number {
  return _active.size;
}

export function isTransferActive(crc32: string): boolean {
  return _active.has(crc32);
}

/** Cancels every in-flight transfer — used on shutdown so partials stop cleanly. */
export function abortAllTransfers(): void {
  for (const t of _active.values()) t.controller.abort();
  _active.clear();
}

/** Where a Pixeldrain download for this episode lands once complete. */
export function destinationFor(filename: string): string {
  return path.join(DOWNLOAD_PATH, filename);
}

/**
 * Whether Pixeldrain can serve this episode right now. Checks the live per-IP
 * limits rather than assuming — One Pace covers the bandwidth for their own
 * files today, but that is their subscription, not a guarantee.
 *
 * Never throws: an unreachable Pixeldrain is simply "not eligible", and the
 * caller uses the torrent.
 */
export async function checkEligible(
  ep: EpisodeRecord
): Promise<{ ok: true; filename: string; size: number } | { ok: false; reason: string }> {
  if (!ep.pixeldrain_id) return { ok: false, reason: "no Pixeldrain link for this release" };
  try {
    const info = await getFileInfo(ep.pixeldrain_id);
    if (!info.canDownload) return { ok: false, reason: "Pixeldrain reports the file is not downloadable" };
    if (!info.name) return { ok: false, reason: "Pixeldrain returned no filename" };

    const limits = await getLimits();
    const verdict = limitsAllow(limits, info.size);
    if (!verdict.ok) return { ok: false, reason: verdict.reason };

    return { ok: true, filename: info.name, size: info.size };
  } catch (err) {
    return { ok: false, reason: `Pixeldrain unreachable (${(err as Error).message})` };
  }
}

/**
 * True when the finished file is already sitting in the download directory.
 * Filesystem-based so it survives a restart with no in-memory bookkeeping.
 */
export function isComplete(ep: EpisodeRecord): boolean {
  if (!ep.original_filename) return false;
  const dest = destinationFor(ep.original_filename);
  return fs.existsSync(dest) && !fs.existsSync(partPathFor(dest));
}

/**
 * Starts (or resumes) the transfer for an episode if there's a slot free. Runs
 * detached: the sweep that called this returns immediately and observes progress
 * on later passes, exactly as it does for a torrent.
 */
export function startTransfer(ep: EpisodeRecord): boolean {
  if (_active.has(ep.crc32)) return false;
  if (_active.size >= MAX_CONCURRENT) return false;
  if (!ep.pixeldrain_id || !ep.original_filename) return false;

  const controller = new AbortController();
  _active.set(ep.crc32, { crc32: ep.crc32, controller, startedAt: Date.now() });

  const dest = destinationFor(ep.original_filename);
  const resuming = fs.existsSync(partPathFor(dest));
  logger.info(resuming ? "Resuming Pixeldrain download" : "Starting Pixeldrain download", {
    crc32: ep.crc32, file: ep.original_filename, id: ep.pixeldrain_id,
  });

  void downloadFile(ep.pixeldrain_id, dest, {
    signal: controller.signal,
    onProgress: (fraction) => recordDownloadProgress(ep.crc32, fraction),
  })
    .then((outcome) => {
      _failures.delete(ep.crc32);
      recordDownloadProgress(ep.crc32, 1);
      logger.info("Pixeldrain download finished", {
        crc32: ep.crc32, bytes: outcome.bytes, resumed: outcome.resumed,
      });
    })
    .catch((err) => {
      const message = (err as Error).message;
      if (controller.signal.aborted) {
        logger.info("Pixeldrain download aborted", { crc32: ep.crc32 });
        return;
      }
      const failures = (_failures.get(ep.crc32) ?? 0) + 1;
      _failures.set(ep.crc32, failures);
      logger.warn("Pixeldrain download failed", { crc32: ep.crc32, attempt: failures, error: message });

      if (failures >= MAX_TRANSFER_FAILURES) {
        // Hand it to BitTorrent. The partial file is removed first: the torrent
        // writes its own copy, and a stale .part would otherwise linger forever.
        _failures.delete(ep.crc32);
        fs.rmSync(partPathFor(dest), { force: true });
        setDownloadVia(ep.crc32, "torrent");
        updateEpisodeStatus(ep.crc32, "pending", { error_message: null });
        logger.warn("Falling back to the torrent for this episode", {
          crc32: ep.crc32, after: `${failures} failed Pixeldrain attempts`, lastError: message,
        });
      }
    })
    .finally(() => {
      _active.delete(ep.crc32);
    });

  return true;
}

/** Drops a fallback decision, so a manual retry gets a clean Pixeldrain attempt. */
export function clearTransferFailures(crc32: string): void {
  _failures.delete(crc32);
}
