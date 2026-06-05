# One Pace Plex Automator — Agent Context

## What This Project Does

Automates download, renaming, and Plex metadata management for **One Pace** — a fan-edited version of One Piece that removes filler and aligns episodes with manga pacing. The user was previously doing all of this manually after Discord notifications.

## Architecture

Single TypeScript/Node.js service running in Docker alongside an existing arr-stack managed via **dockhand**.

### Pipeline (per poll cycle)

1. **RSS poll** (`src/rss.ts`) — polls One Pace RSS feed, extracts new episodes by GUID
2. **Metadata lookup** (`src/metadata.ts`) — fetches YAML files from [`ladyisatis/one-pace-metadata`](https://github.com/ladyisatis/one-pace-metadata) repo (branch `v2`) to resolve arc title, season number, episode number, description
3. **qBittorrent dispatch** (`src/qbittorrent.ts`) — adds magnet to qBittorrent via Web API, stores torrent hash
4. **Completion monitoring** (`src/processor.ts`) — polls qBit every 5 minutes, detects finished downloads
5. **File processing** (`src/fileops.ts`) — finds downloaded file by CRC32, renames and moves to Plex library
6. **Plex update** (`src/plex.ts`) — triggers library scan, finds episode by season/episode number, updates title + summary via Plex API
7. **Discord notification** (`src/discord.ts`) — sends embed webhook on detection and on completion

### State

SQLite at `DATA_DIR/state.db` via `better-sqlite3`. Two tables:
- `episodes` — tracks each episode through its lifecycle (pending → downloading → processing → done/failed)
- `rss_seen` — stores seen RSS GUIDs to prevent re-processing

## Key Data Structures

### Metadata Repo (`ladyisatis/one-pace-metadata`, branch `v2`)

- `arcs/en/{arcNum}/config.yml` — arc config: `part` (= Plex season number), `title`, `resolution`, `episodes[]` (each with CRC32 hash)
- `arcs/en/{arcNum}/episode_{nn}.yml` — episode metadata: `title`, `description`
- `episodes/{CRC32}.yml` — episode file info: `arc`, `episode` (within arc), `file.name` (original filename)
- `data.json` / `data.min.json` — compiled full dataset (alternative to per-file fetching)

### Plex Filename Format

```
One Pace - {arc.title} - S{arc.part:02d}E{episode_num:02d} [{resolution}][{CRC32}].mkv
```

Example: `One Pace - Baratie - S05E01 [1080p][BE634289].mkv`

### CRC32 as the Key

Every One Pace release has a CRC32 hash in its filename `[XXXXXXXX]`. This is the primary key linking:
- RSS entry filename → `episodes/{CRC32}.yml` → arc/episode numbers → `arcs/en/{arcNum}/`

## Existing Stack (dockhand, same server)

Services available on the shared Docker network:
- `qbittorrent` — torrent client with Web API at port 8080
- `plex` — Plex Media Server at port 32400 (running on **baremetal**, not in Docker)
- `sonarr`, `radarr`, `prowlarr`, `bazarr`, `lidarr`, `flaresolverr`, `gluetun`, `seerr`

> **Note:** Plex runs on baremetal. `PLEX_URL` should point to the host IP or hostname, not a container name.

## Configuration

All config via environment variables. See `.env.example` for full list. Key variables:
- `RSS_FEED_URL` — One Pace RSS feed (URL unknown at project init, needs to be discovered)
- `PLEX_LIBRARY_SECTION_ID` — find at `http://{plex}:32400/library/sections`
- `PLEX_SERIES_RATING_KEY` — optional, speeds up episode lookups; find from Plex web UI URL

## Source Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Entry point, cron scheduler, poll cycle orchestration |
| `src/config.ts` | Zod-validated env config |
| `src/db.ts` | SQLite state management |
| `src/rss.ts` | RSS feed polling and parsing |
| `src/metadata.ts` | Fetches/parses ladyisatis YAML, builds Plex filenames, extracts CRC32 |
| `src/qbittorrent.ts` | qBittorrent Web API client |
| `src/fileops.ts` | File rename and move to Plex library |
| `src/plex.ts` | Plex API client (scan, episode lookup, metadata update) |
| `src/processor.ts` | Download completion handler (qBit → rename → Plex → notify) |
| `src/discord.ts` | Discord webhook notifications |
| `src/logger.ts` | Structured console logger |

## RSS Feed Details

URL: `https://onepace.net/en/releases/rss.xml` (requires `User-Agent` header — returns 403 to default curl/fetch, but Node's rss-parser works fine).

Item structure (namespaced fields via `xmlns:torrent="http://xmlns.ezrss.it/0.1/"`):
- `guid` = `urn:btih:{infoHash}` — torrent info hash (stable per release)
- `torrent:magnetURI` — magnet link. Sometimes has full `dn=` param with filename, sometimes minimal (just `xt=urn:btih:...`)
- `torrent:fileName` — `.torrent` filename, present only on some items: `[One Pace][115-117] Little Garden 01 [1080p][BCE915AA].mkv.torrent`
- `torrent:infoHash` — bare hex info hash
- `enclosure` — torrent file download URL (not a magnet)
- `title` — arc name + episode number: `"Little Garden 05"`

**CRC32 extraction priority** (in `src/rss.ts`):
1. `torrent:fileName` (strip `.torrent`, extract `[CRC32]`)
2. `dn=` param in magnet URI (URL-decode, extract `[CRC32]`)
3. Fallback: `lookupCrc32ByTitle()` in `metadata.ts` — parses "Little Garden 05" → searches `data.min.json` by arc title + episode number

## Known Gaps / TODOs

- [ ] **Plex runs on baremetal** — `PLEX_URL` must be host IP/DNS, not `plex` container name. Confirm network routing from container to host.
- [ ] **YAML parser is hand-rolled** — `src/metadata.ts` uses a simple custom parser sufficient for the known schema. If the metadata repo schema changes, revisit.
- [ ] **No retry backoff** — failed episodes are currently just marked `failed`; `retryFailed()` exists but isn't wired into the cron schedule.
- [ ] **Magnet hash extraction** — `qbittorrent.ts` extracts the info hash from the magnet URI via regex. If a magnet doesn't include `urn:btih:`, the hash will be empty string and completion detection will break.

## Development

```bash
npm install
cp .env.example .env   # fill in values
npm run dev            # ts-node, hot-ish
npm run build          # compile to dist/
npm run typecheck      # type check without emitting
```

## Docker Deployment

```bash
# Build and run
docker compose up -d --build

# Logs
docker compose logs -f one-pace-automator
```

The container needs to share volumes with qBittorrent (`QBIT_DOWNLOAD_PATH`) and Plex (`MEDIA_PATH`). These paths must match what qBittorrent saves to and what Plex reads from — on the host, not inside containers.
