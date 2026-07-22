import { logger } from "./logger";
import { version as runningVersion } from "../package.json";

// Every software push to main bumps package.json AND builds the :latest image,
// so main's version is exactly the newest published image version.
const REMOTE_PACKAGE_JSON =
  "https://raw.githubusercontent.com/dyonng/one-pace-plex-automator/main/package.json";
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h — releases aren't frequent

let _latest: string | null = null;
let _lastCheckedAt = 0;
let _inFlight = false;

type Ver = [number, number, number];

export function parseVer(s: string | null | undefined): Ver | null {
  const m = (s ?? "").match(/^(\d+)\.(\d+)\.(\d+)$/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

const newer = (a: Ver, b: Ver): boolean =>
  (a[0] - b[0] || a[1] - b[1] || a[2] - b[2]) > 0;

/** True when semver `candidate` is strictly newer than `base`. Bad input = false. */
export function isVersionNewer(candidate: string | null | undefined, base: string | null | undefined): boolean {
  const c = parseVer(candidate);
  const b = parseVer(base);
  return !!c && !!b && newer(c, b);
}

async function refresh(): Promise<void> {
  if (_inFlight) return;
  _inFlight = true;
  try {
    const resp = await fetch(REMOTE_PACKAGE_JSON, { signal: AbortSignal.timeout(10_000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const pkg = (await resp.json()) as { version?: string };
    if (parseVer(pkg.version)) {
      const changed = _latest !== pkg.version;
      _latest = pkg.version!;
      if (changed) logger.info("Update check", { running: runningVersion, latest: _latest });
    }
  } catch (err) {
    logger.debug("Update check failed (will retry)", { error: (err as Error).message });
  } finally {
    _lastCheckedAt = Date.now();
    _inFlight = false;
  }
}

/**
 * The newest published version, if it's newer than the running one — else null.
 * Non-blocking: returns the cached answer and refreshes in the background when
 * stale, so the status endpoint never waits on GitHub.
 */
export function getUpdateAvailable(): string | null {
  if (Date.now() - _lastCheckedAt > CHECK_INTERVAL_MS) void refresh();
  const cur = parseVer(runningVersion);
  const latest = parseVer(_latest);
  if (!cur || !latest) return null;
  return newer(latest, cur) ? _latest : null;
}
