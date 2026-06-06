# One Pace Plex Automator — Agent Context

## What This Project Does

Automates download, renaming, and Plex metadata management for **One Pace** — a fan-edited
version of One Piece that removes filler and aligns episodes with manga pacing. Replaces a
manual workflow: Discord notification → download → rename → move to Plex folder → add metadata.
Also replaces the old `old_scripts/one_pace_sync.py` (full Plex metadata sync) and
`old_scripts/sync_cast_list.py` (cast actors), which remain in-repo as behavioral reference.

## Architecture

Single TypeScript/Node.js service in Docker, running alongside an existing arr-stack managed
via **dockhand**. Plex runs on **baremetal**, not in Docker.

### Schedules

Two independent timers (set up in `src/index.ts`):

- **`POLL_CRON`** (default `*/5 * * * *`) → `runCycle()` = `pollRss` → `dispatchPending` → `processDownloading`
- **`setInterval(30s)`** → `processDownloading()` only (sub-minute completion check; cron can't go below 1 min)

On startup, `boot()` runs once, then one immediate `runCycle()` + `runMetadataSync()`.

### Pipeline

1. **RSS poll** (`src/rss.ts`) — native `fetch` with `If-Modified-Since`/`304` (last value in `kv`).
   `rss-parser` `customFields` map the `torrent:` namespace. If any unseen item exists, calls
   `refreshMetadata()` **before** resolving (a re-release bumps the episode's CRC32). Extracts the
   changelog from the description CDATA. CRC32 resolution priority:
   `torrent:fileName` → magnet `dn=` param → `lookupCrc32ByTitle()`.
2. **Metadata** (`src/metadata.ts`) — single `data.min.json` from
   [`ladyisatis/one-pace-metadata`](https://github.com/ladyisatis/one-pace-metadata) branch `v2`,
   cached. `refreshMetadata()` does a conditional GET (ETag → 304, ~free when unchanged). Episode
   keys are **uppercase hex CRC32**.
3. **qBittorrent dispatch** (`src/qbittorrent.ts`) — cookie-auth Web API. `addMagnet` sets a
   category but **no savepath** (qBit writes to its own configured dir; we read that same host dir).
4. **Completion** (`src/processor.ts`) — on `isComplete`: find file by CRC32 → `moveAndRename` →
   Plex scan → wait 5s → `syncSingleEpisode` → mark `done` → `runMetadataSync()` (full) →
   Discord → delete torrent (keep file).
5. **File ops** (`src/fileops.ts`) — `moveAndRename` deletes any existing file with the same
   `S##E##` before moving the new one in (handles re-releases and pre-existing library files),
   returns the replaced names.
6. **Plex** (`src/plex.ts`) — resolves section + show by name (cached). All edits use
   `.value`/`.locked` params so the Plex agent can't overwrite custom metadata.
7. **Discord** (`src/discord.ts`) — embeds: `new_episode`, `download_complete`,
   `episode_updated` (changelog + replaced file), `error`.

### State

SQLite at `DATA_DIR/state.db` via `better-sqlite3` (WAL). Three tables:
- `episodes` — lifecycle `pending → downloading → processing → done/failed`; includes `changelog`
  (JSON array, added via `addColumnIfMissing` migration)
- `rss_seen` — seen RSS GUIDs
- `kv` — small key/value (e.g. `rss_last_modified`)

## Re-release Handling (key feature)

One Pace re-releases episodes with edits/fixes. A re-release has a **new CRC32** (and possibly a
different resolution) and a **new RSS GUID**, so it passes the seen-check and inserts a fresh
`episodes` row normally. The swap is **disk-truth based**, keyed on the `S##E##` token — not CRC32:

- `moveAndRename` → `removeExistingEpisodeFiles` deletes any same-`S##E##` file in the season folder
  (regex `S0*<part>(?!\d)E0*<ep>(?!\d)`, padding-agnostic), then moves the new file in.
- One code path covers **both** cases: brand-new episode (nothing deleted → green
  "Download Complete") and re-release (old file deleted → amber "Episode Updated" with changelog).
- Works for files the service never downloaded itself (the user already has 36 populated seasons).
- **Changelog** comes from the RSS `<description>` `<details><summary>Changelog</summary>…` block,
  stored on the `episodes` row at ingestion, rendered at completion.
- **Metadata staleness** is why `refreshMetadata()` runs when the feed has new items: without it the
  re-release's new CRC32 wouldn't resolve and the item would be skipped.

## Resolution Targeting

No explicit resolution filter needed. The metadata holds **exactly one CRC32 per episode**, so an
off-resolution torrent's CRC32 simply isn't found and is skipped. The blessed release is 1080p; the
Plex filename's `[resolution]` tag is read from the torrent filename, defaulting to `1080p`.

## Season Folder Format Detection

`detectSeasonFormat()` (boot) scans `MEDIA_PATH` and builds an `arcPart → folderName` cache from the
folders already on disk, also detecting zero-padding. `buildSeasonFolder` returns the exact on-disk
name for known seasons, falling back to the detected padding style for new ones. The user's library
uses **unpadded** folders (`Season 1 - Romance Dawn`).

## Paths

Hardcoded container constants (`src/constants.ts`) + Docker volume mounts. Not env vars.

| Constant | Value | Mount target (host → container) |
|----------|-------|----------------------------------|
| `MEDIA_PATH` | `/media/one-pace` | One Pace **show root** (season folders directly under it) |
| `DOWNLOAD_PATH` | `/downloads` | qBittorrent's **output dir** (same host dir qBit writes to) |
| `DATA_DIR` | `/data` | persistent state (SQLite) |

The Plex filename format (`buildPlexFilename`):
```
One Pace - {arcTitle} - S{part:02d}E{ep:02d} [{resolution}][{CRC32}].mkv
```
Note: the **filename** zero-pads S/E (Plex convention); the **folder** name does not.

## Configuration

Zod-validated env (`src/config.ts`):

| Var | Default | Notes |
|-----|---------|-------|
| `RSS_FEED_URL` | — | `https://onepace.net/en/releases/rss.xml` |
| `QBIT_URL` | `http://qbittorrent:8080` | container name on shared network |
| `QBIT_USERNAME` / `QBIT_PASSWORD` | `admin` / — | |
| `QBIT_CATEGORY` | `one-pace` | applied on add, filters on completion |
| `PLEX_URL` | `http://plex:32400` | **host IP** — Plex is baremetal |
| `PLEX_TOKEN` | — | |
| `PLEX_LIBRARY_NAME` | `TV Shows` | library containing the "One Pace" show |
| `DISCORD_WEBHOOK_URL` | — (optional) | notifications disabled if unset |
| `POLL_CRON` | `*/5 * * * *` | RSS poll schedule |
| `METADATA_REPO_RAW_BASE` | ladyisatis v2 raw URL | override only for a mirror |

`LOG_LEVEL` is read directly by pino (`src/logger.ts`), not in the Zod schema.

## Source Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Entry point, cron + 30s interval, `runCycle`, `dispatchPending` |
| `src/boot.ts` | Boot sequence: dirs, DB, season-format detect, cache warm, Plex resolve, banner |
| `src/config.ts` | Zod-validated env config |
| `src/constants.ts` | Hardcoded container paths |
| `src/db.ts` | SQLite state + migrations |
| `src/rss.ts` | RSS poll, CRC32 resolution, changelog extraction |
| `src/metadata.ts` | `data.min.json` fetch/cache, conditional refresh, lookups, filename build |
| `src/qbittorrent.ts` | qBittorrent Web API client |
| `src/fileops.ts` | Season-format detection, move/rename, re-release file swap |
| `src/plex.ts` | Plex API (scan, lock-aware metadata update, single + full sync) |
| `src/processor.ts` | Completion handler + `runMetadataSync` |
| `src/discord.ts` | Webhook embeds |
| `src/logger.ts` | pino wrapper (`logger.info(msg, meta)` shape) |

## RSS Feed Details

Item structure (`xmlns:torrent="http://xmlns.ezrss.it/0.1/"`):
- `guid` = `urn:btih:{infoHash}` — stable per release
- `torrent:magnetURI` — magnet; `dn=` filename present on **some** items only
- `torrent:fileName` — `.torrent` name, present on **some** items only:
  `[One Pace][115-117] Little Garden 01 [1080p][BCE915AA].mkv.torrent`
- `description` (CDATA HTML) — `<dl>` chapters/episodes + optional `<details>` **Changelog** list
- `title` — `"Little Garden 05"` (arc name + episode number)

Filename-less items (no `dn`, no `torrent:fileName`) resolve CRC32 via title → metadata lookup.

## Known Gaps / TODOs

- **Plex baremetal routing** — `PLEX_URL` must be host IP/DNS, confirm container→host reachability.
- **Magnet hash regex** — `qbittorrent.ts` pulls the info hash from `urn:btih:`; if absent the hash
  is `""` and completion detection breaks. Fallback could derive it from qBit's added-torrent list.
- **Fixed 5s wait** after Plex scan before `syncSingleEpisode` — may race on slow scans.
- **`retryFailed()`** exists but isn't wired into any schedule.
- **No BEP 9** — filename-less magnets aren't probed for their file list pre-download; they rely on
  the title→metadata lookup instead.

## Development

```bash
npm run install:dev    # npm install --ignore-scripts (skips native build on Windows dev)
cp .env.example .env    # fill in values
npm run typecheck       # ./node_modules/.bin/tsc --noEmit
npm run build           # compile to dist/
```

> `npm run dev` requires the `better-sqlite3` native binary; with `--ignore-scripts` it isn't built,
> so real smoke-testing is done by building the Docker image. A pre-commit hook
> (`.githooks/pre-commit`, wired via the `prepare` script) auto-bumps the patch version.

## Docker Deployment

```bash
docker compose up -d --build
docker compose logs -f one-pace-automator
```

Multi-stage build: the **builder** has `python3 make g++` to compile `better-sqlite3` (musl, no
prebuilt); the **runner** adds `libstdc++` for the addon's runtime link. The container shares two
host dirs — qBittorrent's output (`/downloads`) and the One Pace show root (`/media/one-pace`).
Image is published to GHCR via `.github/workflows/docker.yml`.
