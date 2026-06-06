# One Pace Plex Automator

Automates downloading, renaming, and Plex metadata management for [One Pace](https://onepace.net) — a fan edit of the One Piece anime that removes filler and aligns with manga pacing.

## What it does

1. Polls the One Pace RSS feed on a schedule
2. Detects new episode releases
3. Sends magnet links to qBittorrent
4. Renames completed downloads to Plex naming format
5. Moves files to the correct Plex library folder
6. Updates episode metadata via the Plex API
7. Sends Discord webhook notifications

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
| `QBIT_USERNAME` | qBittorrent username |
| `QBIT_PASSWORD` | qBittorrent password |
| `QBIT_DOWNLOAD_PATH` | Path qBittorrent saves One Pace files to |
| `PLEX_URL` | Plex Media Server URL (use host IP if Plex runs on baremetal) |
| `PLEX_TOKEN` | Plex authentication token |
| `PLEX_LIBRARY_SECTION_ID` | Library section ID for your One Pace library |
| `MEDIA_PATH` | Base path for your TV media library |
| `DISCORD_WEBHOOK_URL` | Discord webhook URL for notifications (optional) |

**Finding your Plex token:**
Open Plex web UI, browse to any media item, open browser devtools → Network tab, look for `X-Plex-Token` in any request.

**Finding your library section ID:**
```bash
curl "http://{plex}:32400/library/sections?X-Plex-Token={token}"
```
Look for the `key` attribute on your One Pace library.

### 2. Deploy via Dockhand (or docker compose)

Paste `docker-compose.yml` into Dockhand and upload your `.env` file, or:

```bash
docker compose up -d
```

## Metadata source

Episode metadata (titles, descriptions, arc mappings) sourced from [ladyisatis/one-pace-metadata](https://github.com/ladyisatis/one-pace-metadata).

## Development

```bash
# Install deps (skips native build for Windows)
npm run install:dev

# Type check
npm run typecheck

# Run locally (requires .env)
npm run dev
```
