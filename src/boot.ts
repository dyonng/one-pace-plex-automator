import { getConfig } from "./config";
import { getData } from "./metadata";
import { resolvePlexConnection } from "./plex";
import { ensureDir, detectSeasonFormat, buildSeasonFolder } from "./fileops";
import { getDb } from "./db";
import { DATA_DIR, DOWNLOAD_PATH, MEDIA_PATH } from "./constants";
import { version as VERSION } from "../package.json";
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
  detectSeasonFormat();

  process.stdout.write("  Fetching One Pace metadata...");
  const meta = await getData();
  process.stdout.write(` ${meta.episodes} episodes, ${meta.arcs} arcs\n`);

  process.stdout.write("  Connecting to Plex...");
  const plex = await resolvePlexConnection();
  process.stdout.write(` "${plex.showTitle}" in "${plex.libraryName}"\n\n`);

  const top    = `┌${"─".repeat(WIDTH)}┐`;
  const bottom = `└${"─".repeat(WIDTH)}┘`;
  const title  = `│${"  One Pace Plex Automator".padEnd(WIDTH - 10)}v${VERSION.padStart(9)}│`;

  const lines = [
    top,
    title,
    divider(),
    section("Plex"),
    row("URL", plex.plexUrl),
    row("Library", plex.libraryName),
    row("Show", plex.showTitle),
    divider(),
    section("qBittorrent"),
    row("URL", config.QBIT_URL),
    divider(),
    section("Metadata"),
    row("Arcs", String(meta.arcs)),
    row("Episodes", String(meta.episodes)),
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
