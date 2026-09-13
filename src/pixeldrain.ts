import fs from "fs";
import path from "path";
import { logger } from "./logger";

/**
 * Pixeldrain client. One Pace publishes most recent releases three ways —
 * magnet, .torrent, and a Pixeldrain direct link — and the direct link is a
 * genuinely different failure domain: a dead VPN port-forward leaves a torrent
 * at `stalledDL` with no peers, while a plain HTTPS GET is unaffected.
 *
 * Their files are covered by One Pace's own paid Pixeldrain bandwidth, so
 * downloading them does not consume the *downloader's* free allowance. That is
 * not guaranteed forever, though, so every download is gated on the live
 * rate-limit endpoint rather than on that assumption.
 */

const API_BASE = "https://pixeldrain.net/api";

// Leave headroom rather than downloading right up to the ceiling: a partial
// transfer that dies at the limit wastes more than deferring to the torrent.
const TRANSFER_HEADROOM_BYTES = 512 * 1024 * 1024;

const INFO_TIMEOUT_MS = 15_000;
// No timeout on the body itself — these are ~1GB files. Stall detection is the
// watchdog's job, driven by the progress this module reports.
const CONNECT_TIMEOUT_MS = 30_000;

export interface PixeldrainLimits {
  serverOverload: boolean;
  speedLimit: number;
  transferLimit: number;
  transferUsed: number;
  downloadLimit: number;
  downloadUsed: number;
}

export interface PixeldrainFileInfo {
  id: string;
  name: string;
  size: number;
  canDownload: boolean;
  downloadSpeedLimit: number;
}

/** Pulls the file id out of a Pixeldrain share URL (`/u/{id}`) or a bare id. */
export function parsePixeldrainId(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  const m = s.match(/pixeldrain\.[a-z]+\/(?:u|api\/file)\/([A-Za-z0-9]+)/i);
  if (m) return m[1];
  return /^[A-Za-z0-9]{4,16}$/.test(s) ? s : null;
}

async function getJson<T>(url: string): Promise<T> {
  const resp = await fetch(url, { signal: AbortSignal.timeout(INFO_TIMEOUT_MS) });
  if (!resp.ok) throw new Error(`Pixeldrain ${url} returned HTTP ${resp.status}`);
  return (await resp.json()) as T;
}

/** Current per-IP limit state. Throws if Pixeldrain can't be reached. */
export async function getLimits(): Promise<PixeldrainLimits> {
  const raw = await getJson<Record<string, unknown>>(`${API_BASE}/misc/rate_limits`);
  return {
    serverOverload: Boolean(raw.server_overload),
    speedLimit: Number(raw.speed_limit ?? 0),
    transferLimit: Number(raw.transfer_limit ?? 0),
    transferUsed: Number(raw.transfer_limit_used ?? 0),
    downloadLimit: Number(raw.download_limit ?? 0),
    downloadUsed: Number(raw.download_limit_used ?? 0),
  };
}

export async function getFileInfo(id: string): Promise<PixeldrainFileInfo> {
  const raw = await getJson<Record<string, unknown>>(`${API_BASE}/file/${id}/info`);
  if (raw.success === false) throw new Error(`Pixeldrain file ${id} is not available`);
  return {
    id,
    name: String(raw.name ?? ""),
    size: Number(raw.size ?? 0),
    canDownload: raw.can_download !== false,
    downloadSpeedLimit: Number(raw.download_speed_limit ?? 0),
  };
}

/**
 * Whether Pixeldrain is currently a sensible choice for a transfer of
 * `sizeBytes`. Returns a human-readable reason when it isn't, so the caller can
 * log exactly why it fell back to the torrent.
 *
 * A transfer_limit of 0 means "no limit advertised" and is not treated as
 * exhausted — One Pace's paid bandwidth reports that way.
 */
export function limitsAllow(
  limits: PixeldrainLimits,
  sizeBytes: number
): { ok: true } | { ok: false; reason: string } {
  if (limits.serverOverload) return { ok: false, reason: "Pixeldrain reports server overload" };
  if (limits.speedLimit > 0) {
    return { ok: false, reason: `Pixeldrain is throttling this IP (speed limit ${limits.speedLimit})` };
  }
  if (limits.downloadLimit > 0 && limits.downloadUsed >= limits.downloadLimit) {
    return { ok: false, reason: "Pixeldrain download count limit reached" };
  }
  if (limits.transferLimit > 0) {
    const remaining = limits.transferLimit - limits.transferUsed;
    if (remaining <= 0) return { ok: false, reason: "Pixeldrain transfer limit reached" };
    if (remaining < sizeBytes + TRANSFER_HEADROOM_BYTES) {
      return {
        ok: false,
        reason: `Pixeldrain transfer allowance too low (${fmtGb(remaining)} left, need ${fmtGb(sizeBytes)})`,
      };
    }
  }
  return { ok: true };
}

const fmtGb = (b: number): string => `${(b / 1024 ** 3).toFixed(1)}GB`;

/**
 * The file's true total size according to the response: `Content-Range` on a
 * partial response ("bytes 100-999/1000"), otherwise `Content-Length` plus
 * whatever we had already written. Null when the server said neither.
 */
function totalFromHeaders(resp: Response, offset: number): number | null {
  const range = resp.headers.get("content-range");
  const m = range?.match(/\/(\d+)\s*$/);
  if (m) return Number(m[1]);
  const len = resp.headers.get("content-length");
  if (len && /^\d+$/.test(len)) return Number(len) + offset;
  return null;
}

/** Where an in-flight download accumulates before being renamed into place. */
export const partPathFor = (destPath: string): string => `${destPath}.part`;

export interface DownloadOutcome {
  destPath: string;
  bytes: number;
  resumed: boolean;
}

/**
 * Streams a Pixeldrain file to `destPath`, resuming from a previous `.part` if
 * one is there. Pixeldrain serves `Accept-Ranges: bytes`, so an interrupted
 * transfer costs only what it had already written.
 *
 * `onProgress` is called with a 0..1 fraction; the caller feeds that to the same
 * download watchdog the torrent path uses, so a stalled HTTP transfer is just as
 * visible as a stalled torrent.
 */
export async function downloadFile(
  id: string,
  destPath: string,
  opts: { expectedSize?: number; signal?: AbortSignal; onProgress?: (fraction: number) => void } = {}
): Promise<DownloadOutcome> {
  const part = partPathFor(destPath);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });

  let offset = 0;
  try {
    offset = fs.statSync(part).size;
  } catch {
    offset = 0; // no partial file — start from the beginning
  }

  const total = opts.expectedSize ?? (await getFileInfo(id)).size;
  if (total > 0 && offset >= total) {
    // Already whole: the rename is all that's left (a crash between the two).
    fs.renameSync(part, destPath);
    return { destPath, bytes: offset, resumed: true };
  }

  const headers: Record<string, string> = {};
  if (offset > 0) headers.Range = `bytes=${offset}-`;

  const resp = await fetch(`${API_BASE}/file/${id}`, {
    headers,
    signal: opts.signal ?? AbortSignal.timeout(CONNECT_TIMEOUT_MS),
  });

  if (offset > 0 && resp.status === 200) {
    // The server ignored our Range and is sending the whole file — start over
    // rather than appending a second copy onto the partial one.
    logger.warn("Pixeldrain ignored the resume range — restarting the download", { id, offset });
    offset = 0;
    fs.rmSync(part, { force: true });
  } else if (offset > 0 && resp.status !== 206) {
    throw new Error(`Pixeldrain resume for ${id} returned HTTP ${resp.status}`);
  }
  if (!resp.ok) throw new Error(`Pixeldrain download of ${id} returned HTTP ${resp.status}`);
  if (!resp.body) throw new Error(`Pixeldrain download of ${id} returned no body`);

  // The response is authoritative about how big the file is; `expectedSize` is
  // only a hint for the pre-flight limit check and can be stale. Trusting the
  // hint would mean accepting a truncated file whenever it read high.
  const authoritativeTotal = totalFromHeaders(resp, offset) ?? total;

  const sink = fs.createWriteStream(part, { flags: offset > 0 ? "a" : "w" });
  let written = offset;
  let lastReported = -1;

  try {
    for await (const chunk of resp.body as unknown as AsyncIterable<Uint8Array>) {
      if (!sink.write(Buffer.from(chunk))) {
        await new Promise<void>((resolve) => sink.once("drain", () => resolve()));
      }
      written += chunk.length;
      if (authoritativeTotal > 0 && opts.onProgress) {
        // Report per whole percent — the watchdog only needs to see movement,
        // and a DB write per chunk would be absurd.
        const pct = Math.floor((written / authoritativeTotal) * 100);
        if (pct !== lastReported) {
          lastReported = pct;
          opts.onProgress(written / authoritativeTotal);
        }
      }
    }
  } finally {
    await new Promise<void>((resolve, reject) => sink.close((e) => (e ? reject(e) : resolve())));
  }

  if (authoritativeTotal > 0 && written < authoritativeTotal) {
    // Keep the .part: the next attempt resumes from here instead of restarting.
    throw new Error(
      `Pixeldrain download of ${id} ended early at ${written}/${authoritativeTotal} bytes`
    );
  }

  fs.renameSync(part, destPath);
  return { destPath, bytes: written, resumed: offset > 0 };
}
