# One Pace Plex Automator

Automates downloading, renaming, and Plex metadata management for [One Pace](https://onepace.net) — a fan edit of the One Piece anime that removes filler and aligns with manga pacing.

## What it does

1. Polls the One Pace RSS feed on a schedule
2. Detects new episode releases (and re-releases with an updated CRC32)
3. Sends magnet links to qBittorrent
4. Renames completed downloads to Plex naming format
5. Moves files to the correct Plex library folder, replacing superseded copies
6. Updates episode metadata via the Plex API
7. Applies fan-made season posters to new seasons (see [Posters](#posters))
8. Sends Discord webhook notifications

A web dashboard (port `8282`) provides live logs, manual controls, editable
settings, a library coverage report, and a system health panel.

## Plex filename format

```
One Pace - {Arc Title} - S{season}E{episode} [{resolution}][{CRC32}].mkv
```

Example: `One Pace - Baratie - S05E01 [1080p][BE634289].mkv`

## Requirements

- qBittorrent with Web UI enabled
- Plex Media Server
- Docker

## Setup

### 1. Create your `.env` file

```bash
cp .env.example .env
```

Fill in the values:

| Variable | Description |
|----------|-------------|
| `RSS_FEED_URL` | One Pace RSS feed (default: `https://onepace.net/en/releases/rss.xml`) |
| `QBIT_URL` | qBittorrent Web UI URL |
| `QBIT_USERNAME` / `QBIT_PASSWORD` | qBittorrent credentials |
| `QBIT_CATEGORY` | Category applied to added torrents (default: `one-pace`) |
| `PLEX_URL` | Plex Media Server URL (use host IP if Plex runs on baremetal) |
| `PLEX_TOKEN` | Plex authentication token |
| `PLEX_LIBRARY_NAME` | Name of the Plex library holding One Pace (default: `TV Shows`) |
| `POLL_CRON` | RSS poll schedule (default: `*/5 * * * *`) |
| `AUTO_DOWNLOAD` | Auto-download discovered releases (default: `true`) |
| `AUTO_POSTERS` | Auto-apply posters to new seasons (default: `true`) |
| `POSTER_REPO_RAW_BASE` | Raw base URL for the poster repo (default: SpykerNZ — see [Posters](#posters)) |
| `DISCORD_WEBHOOK_URL` | Discord webhook URL for notifications (optional) |
| `TZ` | Timezone for cron schedules (default: `UTC`) |

Paths are bound directly as volume mounts in `docker-compose.yml` (`/media/one-pace`
= your One Pace show root, `/downloads` = qBittorrent's output folder), so there are
no path variables to set. The dashboard exposes `POLL_CRON`, `AUTO_DOWNLOAD`,
`AUTO_POSTERS`, and a few others for live editing — a dashboard override wins over
the `.env` value.

**Finding your Plex token:**
Open Plex web UI, browse to any media item, open browser devtools → Network tab, look for `X-Plex-Token` in any request.

### 2. Deploy via Dockhand (or docker compose)

Paste `docker-compose.yml` into Dockhand and upload your `.env` file, or:

```bash
docker compose up -d
```

## Metadata source

Episode metadata (titles, descriptions, arc mappings) sourced from [ladyisatis/one-pace-metadata](https://github.com/ladyisatis/one-pace-metadata).

## Posters

Season and show posters are the fan-made artwork by
[**/u/piratezekk**](https://www.reddit.com/user/piratezekk) — full credit for the
poster set goes to them. The images are pulled from the
[SpykerNZ/one-pace-for-plex](https://github.com/SpykerNZ/one-pace-for-plex) repo,
which distributes them. When a brand-new season first appears,
its poster is applied automatically (`AUTO_POSTERS`, on by default); existing
seasons are left untouched so any art you set manually is preserved. Use **Sync
posters** in the dashboard to fill gaps, or **Force re-sync posters** to re-apply
everything. Point `POSTER_REPO_RAW_BASE` elsewhere to use a different source.

## Development

```bash
# Install deps (skips native build for Windows)
npm run install:dev

# Type check
npm run typecheck

# Run locally (requires .env)
npm run dev
```
