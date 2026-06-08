import { getConfig } from "./config";
import { getData } from "./metadata";
import { resolvePlexConnection } from "./plex";
import { ensureDir, detectSeasonFormat, buildSeasonFolder } from "./fileops";
import { getDb, insertLog, getKv, setKv, markGuidSeen } from "./db";
import { logBus, LogEntry, logger } from "./logger";
import { seedSeenGuids } from "./rss";
import { seedPostersOnFirstRun } from "./posters";
import { DATA_DIR, DOWNLOAD_PATH, MEDIA_PATH } from "./constants";
import { version as VERSION } from "../package.json";

type PlexConn = { plexUrl: string; libraryName: string; showTitle: string };

async function connectPlexWithRetry(attempts = 3): Promise<PlexConn | null> {
  for (let i = 1; i <= attempts; i++) {
    try {
      return await resolvePlexConnection();
    } catch (err) {
      logger.warn("Plex connection failed", { attempt: i, error: (err as Error).message });
      if (i < attempts) await new Promise((r) => setTimeout(r, i * 2000));
    }
  }
  return null;
}

async function loadMetadataWithRetry(
  attempts = 3
): Promise<{ arcs: number; episodes: number } | null> {
  for (let i = 1; i <= attempts; i++) {
    try {
      return await getData();
    } catch (err) {
      logger.warn("Metadata fetch failed", { attempt: i, error: (err as Error).message });
      if (i < attempts) await new Promise((r) => setTimeout(r, i * 2000));
    }
  }
  return null;
}

async function seedOnFirstRun(): Promise<void> {
  if (getKv("rss_seeded") === "1") return;
  try {
    const count = await seedSeenGuids(markGuidSeen);
    setKv("rss_seeded", "1");
    logger.info("First run: seeded feed GUIDs without downloading", { count });
  } catch (err) {
    // Leave the flag unset so it retries next boot rather than mass-downloading.
    logger.warn("First-run seed failed; will retry next boot", { error: (err as Error).message });
  }
}

function initLogPersistence(): void {
  logBus.on("log", (entry: LogEntry) => {
    try {
      insertLog(entry);
    } catch (err) {
      // Never log via logger here — would recurse through logBus.
      console.error("Failed to persist log:", (err as Error).message);
    }
  });
}
const WIDTH = 52;

function row(label: string, value: string): string {
  const content = `  ${label.padEnd(16)} ${value}`;
  const padded = content.padEnd(WIDTH);
  return `│${padded}│`;
}

function section(title: string): string {
  const content = `  ${title}`;
  return `│${content.padEnd(WIDTH)}│`;
}

function divider(): string {
  return `├${"─".repeat(WIDTH)}┤`;
}

export async function boot(): Promise<void> {
  const config = getConfig();

  ensureDir(DATA_DIR);
  getDb();
  initLogPersistence();
  detectSeasonFormat();

  await seedOnFirstRun();

  process.stdout.write("  Fetching One Pace metadata...");
  // Don't crash-loop if the dataset host is briefly down — continue without it;
  // the first poll cycle (and every resolve) re-fetches on demand.
  const meta = await loadMetadataWithRetry();
  process.stdout.write(
    meta ? ` ${meta.episodes} episodes, ${meta.arcs} arcs\n` : " unavailable\n"
  );

  process.stdout.write("  Connecting to Plex...");
  // Don't crash-loop if Plex is briefly unreachable (e.g. baremetal restart) —
  // continue without it; later syncs re-resolve the connection on demand.
  const plex = await connectPlexWithRetry();
  process.stdout.write(plex ? ` "${plex.showTitle}" in "${plex.libraryName}"\n\n` : " unreachable\n\n");

  // Mark existing posters as applied so auto-posters only touches future seasons
  // (preserves any art the user set manually). Needs Plex; retries next boot if down.
  if (plex) await seedPostersOnFirstRun();

  const top    = `┌${"─".repeat(WIDTH)}┐`;
  const bottom = `└${"─".repeat(WIDTH)}┘`;
  const title  = `│${"  One Pace Plex Automator".padEnd(WIDTH - 10)}v${VERSION.padStart(9)}│`;

  const lines = [
    top,
    title,
    divider(),
    section("Plex"),
    row("URL", plex?.plexUrl ?? config.PLEX_URL),
    row("Library", plex?.libraryName ?? config.PLEX_LIBRARY_NAME),
    row("Show", plex?.showTitle ?? "(unreachable)"),
    divider(),
    section("qBittorrent"),
    row("URL", config.QBIT_URL),
    divider(),
    section("Metadata"),
    row("Arcs", meta ? String(meta.arcs) : "(unavailable)"),
    row("Episodes", meta ? String(meta.episodes) : "(unavailable)"),
    divider(),
    section("Paths"),
    row("Media", MEDIA_PATH),
    row("Season Format", buildSeasonFolder("Example", 1)),
    row("Downloads", DOWNLOAD_PATH),
    row("Data", DATA_DIR),
    divider(),
    section("Schedule"),
    row("RSS Poll", config.POLL_CRON),
    row("DL Check", "every 30s"),
    bottom,
  ];

  console.log(lines.join("\n"));
}
