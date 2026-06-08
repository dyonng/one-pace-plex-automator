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
settings, a **library coverage report**, **live download progress**, and a system
health panel.

### Library coverage & upgrades

The dashboard scans your media folder and diffs it against the One Pace catalog,
classifying every episode as **present**, **upgradeable** (an out-of-date CRC32 —
a newer release exists), **downloading** (the new release is in the pipeline), or
**missing**. Upgradeable episodes split into **Upgrade Now** (a download link is
available — click to compare old vs new and queue the upgrade, individually or in
a batch) and **Cannot Upgrade Automatically** (no link in the feed yet). The
coverage report refreshes itself when an episode finishes or a pipeline action runs.

### Extended cuts

Some episodes have both a **standard** and an **extended** cut. By default the
extended cut is treated as the one to have (`PREFER_EXTENDED`): it's the canonical
release in coverage, the RSS poll won't replace an extended cut on disk with a
standard re-release, and extended files are tagged `[Extended]` in the filename.

### Normalize file naming

The **Normalize File Naming** operation scans the library for files whose names
don't match the canonical scheme (old arc titles, raw source names, a missing
`[Extended]` tag, etc.), previews the old → new name for each, and batch-renames
the selected ones.

## Plex filename format

```
One Pace - {Arc Title} - S{season}E{episode} [{resolution}][{CRC32}].mkv
One Pace - {Arc Title} - S{season}E{episode} [{resolution}][{CRC32}][Extended].mkv   # extended cut
```

Examples:
- `One Pace - Baratie - S05E01 [1080p][BE634289].mkv`
- `One Pace - Reverse Mountain - S09E02 [1080p][3B7CBD0F][Extended].mkv`

## Requirements

- qBittorrent with Web UI enabled
- Plex Media Server
- Docker

## Deployment

### Docker Compose (recommended)

Save this as `docker-compose.yml`, change the five highlighted values, and run
`docker compose up -d`. This is a complete, self-contained config — no `.env` or
external network required.

```yaml
services:
  one-pace-automator:
    image: ghcr.io/dyonng/one-pace-plex-automator:latest
    container_name: one-pace-automator
    restart: unless-stopped
    ports:
      - "8282:8282"
    environment:
      - RSS_FEED_URL=https://onepace.net/en/releases/rss.xml
      - QBIT_URL=http://192.168.1.10:8080      # qBittorrent Web UI (host IP)
      - QBIT_PASSWORD=CHANGE_ME                # <-- your qBittorrent password
      - PLEX_URL=http://192.168.1.10:32400     # <-- your Plex (host IP)
      - PLEX_TOKEN=CHANGE_ME                   # <-- your Plex token
      - TZ=America/Toronto                     # <-- your timezone
    volumes:
      - ./data:/data
      - /path/to/your/one-pace:/media/one-pace # <-- your One Pace show folder
      - /path/to/your/downloads:/downloads     # <-- qBittorrent's output folder
```

Then open `http://<host>:8282` for the dashboard. See [Configuration](#configuration)
for the optional variables you can add to the `environment:` list.

> **Tip:** prefer keeping secrets out of the compose file? Replace a value with
> `${PLEX_TOKEN}` (etc.) and put `PLEX_TOKEN=...` in a `.env` file beside it —
> Compose loads it automatically. The repo's [`docker-compose.yml`](docker-compose.yml)
> is set up this way and also supports joining an existing `media-stack` network so
> you can reference qBittorrent by container name instead of host IP.

### Manual (docker run)

Run the published image directly, supplying config with `--env-file` (or repeated
`-e` flags) and binding the two media paths:

```bash
docker run -d \
  --name one-pace-automator \
  --restart unless-stopped \
  --env-file .env \
  -p 8282:8282 \
  -v /path/to/your/one-pace:/media/one-pace \
  -v /path/to/your/downloads:/downloads \
  -v "$PWD/data:/data" \
  ghcr.io/dyonng/one-pace-plex-automator:latest
```

With `--env-file`, the `${VAR:-default}` fallbacks in the compose file don't apply,
so make sure every value you need is set explicitly in `.env`.

## Configuration

Settings are passed as environment variables. Required values must be set; the
rest fall back to the defaults shown.

| Variable | Required | Description |
|----------|:--------:|-------------|
| `RSS_FEED_URL` | ✅ | One Pace RSS feed (e.g. `https://onepace.net/en/releases/rss.xml`) |
| `QBIT_PASSWORD` | ✅ | qBittorrent password |
| `PLEX_URL` | ✅ | Plex Media Server URL (use host IP if Plex runs on baremetal) |
| `PLEX_TOKEN` | ✅ | Plex authentication token |
| `QBIT_URL` | | qBittorrent Web UI URL (default `http://qbittorrent:8080`) |
| `QBIT_USERNAME` | | qBittorrent username (default `admin`) |
| `QBIT_CATEGORY` | | Category applied to added torrents (default `one-pace`) |
| `PLEX_LIBRARY_NAME` | | Plex library holding One Pace (default `TV Shows`) |
| `POLL_CRON` | | RSS poll schedule (default `*/5 * * * *`) |
| `POLL_ENABLED` | | Gate the scheduled RSS poll; `false` = manual-only (default `true`) |
| `DOWNLOAD_CHECK_SECONDS` | | qBittorrent completion-check interval (default `30`) |
| `AUTO_DOWNLOAD` | | Auto-download discovered releases (default `true`) |
| `AUTO_POSTERS` | | Auto-apply posters to new seasons (default `true`) |
| `PREFER_EXTENDED` | | Prefer the extended cut when an episode has both (default `true`) |
| `PREFER_ARABASTA` | | Render arc 14's title as "Arabasta" instead of the dataset's "Alabasta" (default `true`) |
| `POSTER_REPO_RAW_BASE` | | Raw base URL for the poster repo (default: SpykerNZ — see [Posters](#posters)) |
| `DISCORD_WEBHOOK_URL` | | Discord webhook URL for notifications |
| `TZ` | | Timezone for cron schedules (default `UTC`) |

Two host paths are bound as volumes: your One Pace show root → `/media/one-pace`,
and qBittorrent's output folder → `/downloads` (set these on the `volumes:` mounts
in the compose example above). The dashboard's **Settings** panel is split into
**System & Services** (polling, intervals, feed/integration URLs) and
**Preferences** (`AUTO_DOWNLOAD`, `AUTO_POSTERS`, `PREFER_EXTENDED`,
`PREFER_ARABASTA`); these can be edited live, and a dashboard override wins over
the env value.

**Finding your Plex token:**
Open Plex web UI, browse to any media item, open browser devtools → Network tab, look for `X-Plex-Token` in any request.

## Download sources

Downloads come from the **RSS feed**: each release's `magnet:` URI is pulled from
its RSS item and handed to qBittorrent. If an item has **no magnet** but does
provide an http(s) `.torrent` URL (in its `<enclosure>` or `<link>`), that's used
as a fallback — qBittorrent accepts either. Magnets are preferred because they
carry the info hash inline; for a `.torrent` URL the hash is resolved from
qBittorrent right after adding. There's no plain direct/HTTP *file* download
(only torrents/magnets).

## Metadata source

Episode metadata (titles, descriptions, arc mappings, and the standard/extended
CRC32 for every episode) is sourced from
[ladyisatis/one-pace-metadata](https://github.com/ladyisatis/one-pace-metadata)
(`v2/metadata/data.min.json`).

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
