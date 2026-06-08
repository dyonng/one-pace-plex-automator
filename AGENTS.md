# One Pace Plex Automator — Agent Context

## What This Project Does

Automates download, renaming, and Plex metadata management for **One Pace** — a fan-edited
version of One Piece that removes filler and aligns episodes with manga pacing. Replaces a
manual workflow: Discord notification → download → rename → move to Plex folder → add metadata.
Also replaces the old `old_scripts/one_pace_sync.py` (full Plex metadata sync) and
`old_scripts/sync_cast_list.py` (cast actors), which remain in-repo as behavioral reference.

## Architecture

Single TypeScript/Node.js service in Docker, running alongside an existing arr-stack
deployed as a Docker Compose stack. Plex runs on **baremetal**, not in Docker.

### Schedules

Two independent timers, owned by `src/scheduler.ts` (so they can be re-applied live when settings
change). The cycle logic lives in `src/cycle.ts` (`pollRss` → `dispatchPending` →
`processDownloading`); `src/index.ts` only wires boot/dashboard/scheduler/shutdown.

- **`POLL_CRON`** (default `*/5 * * * *`, dashboard-editable) → routed through `runAction("poll")`
  so the cron never overlaps a manual dashboard trigger (shared action lock in `src/controls.ts`).
  Invalid cron falls back to the default. Gated by **`POLL_ENABLED`** (default `true`,
  dashboard-editable): when `false` the cron isn't scheduled — polling is manual-only (the dashboard
  "Poll RSS" button still works); the download-check interval is unaffected.
- **download-check interval** (`DOWNLOAD_CHECK_SECONDS`, default 30, dashboard-editable) →
  `processDownloading()` only (sub-minute completion check; cron can't go below 1 min). Skips the
  tick while a heavier action holds the lock.

Both reschedule live via `settingsBus` when changed from the dashboard. On startup, `boot()` runs
once, the dashboard + scheduler start, then one immediate `runCycle()`. There is **no** full
metadata sync on boot — sync is download-driven (see Pipeline step 4).

### Pipeline

1. **RSS poll** (`src/rss.ts` + `src/cycle.ts`) — native `fetch` with `If-Modified-Since`/`304` (last
   value in `kv`). `rss-parser` `customFields` map the `torrent:` namespace. If any unseen item
   exists, calls `refreshMetadata()` **before** resolving (a re-release bumps the episode's CRC32).
   Extracts the changelog from the description CDATA. CRC32 resolution priority:
   `torrent:fileName` → magnet `dn=` param → `lookupCrc32ByTitle()`.
   **Download mode** (`AUTO_DOWNLOAD` setting, default on): when on, a discovered release is queued
   immediately (`pending` → qBit → `downloading`); when off, it's stored as **`available`** and
   waits for a manual Download from the dashboard. Either way a `new_episode` Discord ping fires.
2. **Metadata** (`src/metadata.ts`) — single `data.min.json` from
   [`ladyisatis/one-pace-metadata`](https://github.com/ladyisatis/one-pace-metadata) branch `v2`,
   cached. `refreshMetadata()` does a conditional GET (ETag → 304, ~free when unchanged). Episode
   keys are **uppercase hex CRC32**.
3. **qBittorrent dispatch** (`src/qbittorrent.ts`) — cookie-auth Web API. `addMagnet` sets a
   category but **no savepath** (qBit writes to its own configured dir; we read that same host dir).
4. **Completion** (`src/processor.ts`) — on `isComplete`: find file by CRC32 → `moveAndRename` →
   Plex scan → wait 5s → `syncSingleEpisode` (updates the episode **and** its season) → mark
   `done` → Discord → delete torrent (keep file). Sync is download-driven; the full-library
   `runMetadataSync()` is **not** auto-called — it's manual only (dashboard "Full Plex sync").
5. **File ops** (`src/fileops.ts`) — `moveAndRename` deletes any existing file with the same
   `S##E##` before moving the new one in (handles re-releases and pre-existing library files),
   returns the replaced names.
6. **Plex** (`src/plex.ts`) — resolves section + show by name (cached). All edits use
   `.value`/`.locked` params so the Plex agent can't overwrite custom metadata.
7. **Discord** (`src/discord.ts`) — embeds: `new_episode`, `download_complete`,
   `episode_updated` (changelog + replaced file), `error`.

### State

SQLite at `DATA_DIR/state.db` via `better-sqlite3` (WAL). Five tables:
- `episodes` — lifecycle `available → pending → downloading → processing → done/failed`
  (`available` = discovered but awaiting manual download); includes `changelog` (JSON array, added
  via `addColumnIfMissing` migration)
- `rss_seen` — seen RSS GUIDs
- `kv` — small key/value (e.g. `rss_last_modified`, `rss_seeded`)
- `logs` — dashboard log history; `insertLog` auto-prunes to the newest 1000 rows
- `settings` — runtime setting overrides (dashboard edits; see Runtime Settings)

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

## Dashboard

Single-page web UI on port `8282` (config `DASHBOARD_PORT`), for viewing logs and triggering
stages without touching the deployment stack manager.

- **Server** (`src/web/server.ts`) — native Node `http` (no express). The dashboard **always
  starts**; auth is checked **per request** via `checkRequestAuth` so changes apply live. Routes:
  `GET /api/status`, `GET /api/logs`, `GET /api/logs/stream` (SSE), `POST /api/actions/<id>`,
  `POST /api/episodes/<crc32>/<action>`, settings + auth endpoints, plus static files from `public/`.
- **Auth** (`src/web/auth.ts`) — runtime-managed, stored in `kv` (`auth_hash`, `auth_enabled`):
  - Password is set/changed from the dashboard (UI → `POST /api/auth/password` → `hashToken`
    scrypt salted hash; plaintext never stored). `npm run hash-token` + env are an optional bootstrap.
  - **Precedence:** DB hash (UI) > env `DASHBOARD_TOKEN_HASH` > env `DASHBOARD_TOKEN`.
  - `auth_enabled` toggle (`POST /api/auth/toggle`); enabling is rejected without a password.
    Default: enabled iff a secret exists. With no secret the dashboard runs **open** (logged loud).
  - scrypt verify is cached by password fingerprint (slow hash runs once, not per request). HTTP
    **Basic auth — base64, not encrypted in transit**; front with TLS if exposed beyond LAN.
- **Actions** (`src/controls.ts`) — `poll`, `sync`, `refresh-metadata`, `retry-failed`, serialized
  behind one lock (`isBusy`/`withLock`) so manual triggers never overlap the cron cycle. Tracks
  last-run timestamps in `runtime`. `sync` is the home of the otherwise-unwired `runMetadataSync`.
- **Logs** — `logger.ts` emits every line on an `EventEmitter` (`logBus`). `boot.ts` subscribes to
  persist into the `logs` table; the server subscribes to broadcast over SSE. The page loads history
  from `GET /api/logs`, then live-tails via SSE.

### Runtime Settings (`src/settings.ts`)

A few settings are editable live from the dashboard without a redeploy: **POLL_CRON**,
**POLL_ENABLED** (bool), **DOWNLOAD_CHECK_SECONDS**, **AUTO_DOWNLOAD** (bool), **AUTO_POSTERS**
(bool), **DISCORD_WEBHOOK_URL**, **RSS_FEED_URL**, **POSTER_REPO_RAW_BASE**.
(Secrets and volume paths stay env-only by design.)

- **Precedence: DB override > env > default.** Env is the seed; a dashboard edit writes a `settings`
  table row that wins. "Reset" deletes the override (reverts to env). `describeSettings()` reports
  `overridden` + the env value so the UI can badge it.
- Each setting has a **validator** (cron via `cron.validate`, int range, URL) — invalid input is
  rejected at `POST /api/settings` (400) and never reaches the running config, so a typo can't break
  the loop.
- **Live apply:** `settings.ts` emits on `settingsBus`; `src/scheduler.ts` (which owns the cron task
  + the download-check interval) re-applies POLL_CRON / POLL_ENABLED / DOWNLOAD_CHECK_SECONDS on change. RSS URL and
  Discord webhook are read per-use via `getSettingValue`, so they take effect immediately.
- API: `GET /api/settings`, `POST /api/settings` `{key,value}`, `POST /api/settings/reset` `{key}`.

### Per-episode actions

Each episode row has controls, served by `POST /api/episodes/<crc32>/<action>` →
`runEpisodeAction` in `src/controls.ts` (lock-aware):
- `download` / `retry` — `addMagnet` the stored magnet → `downloading` (download on `available`,
  retry on `failed`)
- `resync` — re-push that one episode's metadata to Plex (`syncSingleEpisode`)
- `remove` — delete the DB row; body `{deleteFile:true}` also removes the media file
  (`deleteEpisodeFile`)

### Frontend design

"Command deck" aesthetic (`frontend/src/app.css`): custom daisyUI theme `onepace` — deep slate base,
warm amber-gold primary (One Piece sunset), sea-cyan secondary, coral accent. Self-hosted fonts via
`@fontsource` (bundled, no CDN): **Chakra Petch** (display) + **IBM Plex Sans/Mono** (body/data).
Layered radial-gradient background, `.deck-card` hairline+shadow, `.eyebrow` section labels.
Components: `NewReleases` (hero — `available` releases with changelog + Download), `Episodes` (table
+ per-row actions + remove-confirm modal), `Stats`, `Controls`, `InfoCards`, `Settings`, `Logs`,
`Toasts`.

### Frontend (`frontend/`)

Svelte 5 + Vite, daisyUI (Tailwind v4 via `@tailwindcss/vite`). Build-time only — the runtime image
ships just the compiled static output.

- `vite build` compiles `frontend/` → `public/` (hashed `assets/` + `index.html`). The Node server
  serves `public/` via `serveStatic`. `public/` is **generated and gitignored**.
- Config files are `.mts`/`.mjs` (`vite.config.mts`, `svelte.config.mjs`) so the ESM frontend
  tooling coexists with the CommonJS backend without setting `"type": "module"`.
- Components: `frontend/src/App.svelte` + `lib/` (`Navbar`, `Controls`, `Stats`, `InfoCards`,
  `Episodes`, `Logs`, `Toasts`); `lib/api.ts` (typed fetchers), `lib/stores.ts` (status/logs/toasts
  stores + SSE), `lib/util.ts`. Backend API is framework-agnostic — the frontend can be swapped
  without backend changes.
- `npm run dev:web` runs Vite HMR, proxying `/api` → `:8282`.

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
| `POLL_CRON` | `*/5 * * * *` | RSS poll schedule (dashboard-editable) |
| `POLL_ENABLED` | `true` | gate the scheduled RSS poll; `false` = manual-only (dashboard-editable) |
| `DOWNLOAD_CHECK_SECONDS` | `30` | qBit completion check interval (dashboard-editable) |
| `AUTO_DOWNLOAD` | `true` | auto-queue discovered releases; off = manual download (dashboard-editable) |
| `DASHBOARD_TOKEN_HASH` | — (optional bootstrap) | scrypt hash; password is normally set in the UI |
| `DASHBOARD_TOKEN` | — (optional bootstrap) | plaintext password fallback; used only if no hash |
| `DASHBOARD_PORT` | `8282` | dashboard listen + published port |
| `METADATA_REPO_RAW_BASE` | ladyisatis v2 raw URL | override only for a mirror |

`LOG_LEVEL` is read directly by pino (`src/logger.ts`), not in the Zod schema.

## Source Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Entry point: wires `boot`, dashboard, scheduler, graceful shutdown + error handlers |
| `src/boot.ts` | Boot: dirs, DB, log persistence, first-run seed, season-format detect, cache warm, Plex resolve, banner |
| `src/cycle.ts` | `pollRss`, `dispatchPending`, `runCycle` (extracted so server/scheduler can trigger them) |
| `src/scheduler.ts` | Owns the cron task + download-check interval; re-applies them on settings change |
| `src/settings.ts` | Runtime-editable settings (DB override > env > default), validation, change bus |
| `src/controls.ts` | Manual dashboard actions behind a serialization lock + runtime timestamps |
| `src/config.ts` | Zod-validated env config |
| `src/constants.ts` | Hardcoded container paths |
| `src/db.ts` | SQLite state + migrations; episode/log/count queries |
| `src/rss.ts` | RSS poll, CRC32 resolution, changelog extraction |
| `src/metadata.ts` | `data.min.json` fetch/cache, conditional refresh, lookups, filename build |
| `src/qbittorrent.ts` | qBittorrent Web API client |
| `src/fileops.ts` | Season-format detection, move/rename, re-release file swap |
| `src/plex.ts` | Plex API (scan, lock-aware metadata update, single + full sync) |
| `src/processor.ts` | Completion handler; `runMetadataSync`/`retryFailed` (manual-only) |
| `src/discord.ts` | Webhook embeds |
| `src/logger.ts` | pino wrapper (`logger.info(msg, meta)` shape) + `logBus` emitter |
| `src/web/server.ts` | Dashboard HTTP server (status API, SSE logs, action + settings endpoints) |
| `src/web/auth.ts` | Basic-auth verifier (scrypt hash preferred; cached per password) |
| `frontend/` | Svelte 5 + Vite dashboard UI (builds to `public/`) |

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
- **`retryFailed()` / `runMetadataSync()`** are manual-only (dashboard buttons), not scheduled — by
  design, but there's no automatic retry/backoff for failed episodes.
- **No BEP 9** — filename-less magnets aren't probed for their file list pre-download; they rely on
  the title→metadata lookup instead.

## Development

```bash
npm run install:dev    # npm install --ignore-scripts (skips native build on Windows dev)
cp .env.example .env    # fill in values
npm run typecheck       # backend: ./node_modules/.bin/tsc --noEmit
npm run build           # backend tsc -> dist/  +  vite build -> public/
npm run dev:web         # frontend HMR (proxies /api -> :8282)
npm run mock            # mock backend on :8282 (no sqlite/Plex/qBit, no auth) for frontend dev
```

> Frontend can be developed/tested without the real backend: run `npm run mock`
> (`scripts/mock-server.mjs` — canned API + live fake logs + interactive actions) then
> `npm run dev:web`. Lets the whole dashboard be exercised on Windows despite the
> `better-sqlite3` blocker.

> `npm run dev` (the backend) requires the `better-sqlite3` native binary; with `--ignore-scripts`
> it isn't built, so real smoke-testing is done by building the Docker image. Frontend builds/HMR
> work fine on Windows (no native deps). A pre-commit hook (`.githooks/pre-commit`, wired via the
> `prepare` script) auto-bumps the patch version — note it cannot spawn under Git for Windows
> (shell-hook spawn issue), so on Windows the bump must be done manually (`npm version patch
> --no-git-tag-version`).

## Docker Deployment

```bash
docker compose up -d --build
docker compose logs -f one-pace-automator
```

Multi-stage build: the **builder** has `python3 make g++` to compile `better-sqlite3` (musl, no
prebuilt) and runs `npm run build` (tsc + vite, producing `dist/` and `public/`); the **runner**
adds `libstdc++` for the addon's runtime link and copies `dist/`, `public/`, and `node_modules`.
Exposes `8282` (dashboard). The container shares two host dirs — qBittorrent's output
(`/downloads`) and the One Pace show root (`/media/one-pace`) — and publishes `DASHBOARD_PORT`.
Image is published to GHCR via `.github/workflows/docker.yml`.
