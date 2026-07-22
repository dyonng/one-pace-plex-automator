# One Pace Plex Automator — Agent Context

## What This Project Does

Automates download, renaming, and Plex metadata management for **One Pace** — a fan-edited
version of One Piece that removes filler and aligns episodes with manga pacing. Replaces a
manual workflow: Discord notification → download → rename → move to Plex folder → add metadata.
Also replaces the old `old_scripts/one_pace_sync.py` (full Plex metadata sync); the old
`old_scripts/sync_cast_list.py` (cast actors) informed `src/casting.ts` (see Casting). Both
remain in-repo as behavioral reference.

## Architecture

Single TypeScript/Node.js service in Docker, running alongside an existing arr-stack
deployed as a Docker Compose stack. Plex runs on **baremetal**, not in Docker.

### Schedules

Two independent timers, owned by `src/scheduler.ts` (so they can be re-applied live when settings
change). The cycle logic lives in `src/cycle.ts` (`pollRss` → `dispatchPending` →
`processDownloading`); `src/index.ts` only wires boot/dashboard/scheduler/shutdown.

- **`POLL_CRON`** (default `*/5 * * * *`, dashboard-editable) → routed through
  `runAction("refresh-sources")` so the cron never overlaps a manual dashboard trigger (shared
  action lock in `src/controls.ts`). Invalid cron falls back to the default. Gated by
  **`POLL_ENABLED`** (default `true`, dashboard-editable): when `false` the cron isn't scheduled —
  refreshing is manual-only (the dashboard "Refresh Sources" button still works); the
  download-check interval is unaffected.
- **DB backup cron** (fixed `0 4 * * *`, not dashboard-editable) → `backupDatabase()`; plus a
  boot-time `backupIfStale()` catch-up for servers that were off at 04:00.
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
   **Extended-cut preference:** before queueing, `isPreferredRelease(crc32)` is checked — when
   `PREFER_EXTENDED` is on and an episode has both cuts, the non-preferred variant (e.g. a standard
   re-release) is skipped and its GUID marked seen, so it never replaces an extended cut on disk.
2. **Metadata** (`src/metadata.ts`, supplemented by `src/onepace-sheet.ts` +
   `src/onepace-descriptions.ts`) — the richer `metadata/data.min.json` from
   [`ladyisatis/one-pace-metadata`](https://github.com/ladyisatis/one-pace-metadata) branch `v2`
   (URL is `${METADATA_REPO_RAW_BASE}/metadata/data.min.json`), cached. `refreshMetadata()` does a
   conditional GET (ETag → 304, ~free when unchanged). Schema:
   - `arcs.en[]` — `{ part, saga, title, description, episodes: [{ episode, standard, extended }] }`.
     The `episodes[]` list maps each (arc part, episode) to its **current** standard CRC32 and
     extended CRC32 (`""` when no extended cut). This is the authoritative canonical-release source.
   - `descriptions.en[]` — `{ arc, episode, title, description }` keyed by (arc **part**, episode).
   - `episodes{CRC32}` — per-release technical metadata `{ arc, episode, manga_chapters,
     anime_episodes, released, duration, extended, file:{name,size,…} }`, **retains release history**
     (older re-release CRC32s stay), so any historical CRC32 still resolves.
   Module builds lookup indexes (`arcByPart`, `descByKey`, `variantByKey`) on load. `resolveEpisodeByCrc32`,
   `getAllEpisodes`, `getAllArcs` preserve their old return types but now also carry an **`extended`**
   flag. Episode keys are **uppercase hex CRC32**.
   **Google Sheets supplement** (gated on `GOOGLE_SHEETS_API_KEY`; no-op without it): two sheets
   are usually updated before the published dataset, so they recover data for brand-new releases —
   `src/onepace-sheet.ts` reads the official One Pace episode guide (`ONEPACE_SHEET_ID`; per-arc tabs
   with standard/extended CRC32s) and `src/onepace-descriptions.ts` reads the dataset maintainer's
   working sheet (`ONEPACE_METADATA_SHEET_ID`; episode/arc titles + descriptions). Both cache for 6h
   and are cleared + eagerly re-fetched by "Refresh Sources". Arc-title matching across sources goes
   through `canonicalizeArcTitle()` (`src/arc-titles.ts`), which folds spelling variants
   (Arabasta/Alabasta, Whiskey/Whisky Peak).
3. **qBittorrent dispatch** (`src/qbittorrent.ts`) — cookie-auth Web API. `addMagnet` sets a
   category but **no savepath** (qBit writes to its own configured dir; we read that same host dir).
   **Download sources come from the RSS feed.** `extractMagnet` prefers a `magnet:` URI
   (`torrent:magnetURI` / `link` / `enclosure`); when none exists it falls back to an http(s)
   `.torrent` URL (enclosure type `application/x-bittorrent` or a `.torrent` link), which qBit's add
   endpoint accepts in the same `urls` field. For magnets the info hash is read inline from
   `urn:btih:`; for a torrent URL (or base32/v2 magnet) `addMagnet` resolves the hash by diffing the
   category's torrent list after the add (completion detection keys off that hash). No plain
   direct/HTTP *file* download.
4. **Completion** (`src/processor.ts`) — on `isComplete`: resolve metadata → build filename
   (`buildPlexFilename` with the resolved arc title + `extended` flag) → find file by CRC32 →
   `moveAndRename` → Plex scan → wait 5s → `syncSingleEpisode` (updates the episode **and** its
   season) → mark `done` → Discord → delete torrent (keep file). After the cycle, if anything
   completed, re-scans coverage (`refreshCoverageIfPresent`). Sync is download-driven; the
   full-library `runMetadataSync()` is **not** auto-called — it's manual only (dashboard "Full Plex sync").
5. **File ops** (`src/fileops.ts`) — `moveAndRename` deletes any existing file with the same
   `S##E##` before moving the new one in (handles re-releases and pre-existing library files),
   returns the replaced names.
6. **Plex** (`src/plex.ts`) — resolves section + show by name (cached). All edits use
   `.value`/`.locked` params so the Plex agent can't overwrite custom metadata.
7. **Discord** (`src/discord.ts`) — embeds: `new_episode`, `download_complete`,
   `episode_updated` (changelog + replaced file), `error`.

### State

SQLite at `DATA_DIR/state.db` via `better-sqlite3` (WAL). Six tables:
- `episodes` — lifecycle `available → pending → downloading → processing → done/failed`
  (`available` = discovered but awaiting manual download); includes `changelog` (JSON array, added
  via `addColumnIfMissing` migration)
- `rss_seen` — seen RSS GUIDs
- `kv` — small key/value (e.g. `rss_last_modified`, `rss_seeded`, `coverage_report`,
  `coverage_scanned_at`, `metadata_audit_report`, `metadata_audit_scanned_at`,
  `magnet:<crc32>` magnet cache for one-click upgrades)
- `logs` — dashboard log history; `insertLog` auto-prunes to the newest 1000 rows
- `settings` — runtime setting overrides (dashboard edits; see Runtime Settings)
- `plex_meta_state` — per-episode metadata/thumbnail reconciliation state (see
  Metadata & Thumbnail Reconciliation), keyed by the stable `season_episode_id`

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

## Extended Cuts (key feature)

Some episodes ship as both a **standard** and an **extended** cut — two CRC32s with the same
arc/episode/title/release date. The richer metadata distinguishes them explicitly (`arcs.en[].episodes[]`
gives `standard` + `extended` CRC32; `episodes{crc}.extended` is a bool). Controlled by **`PREFER_EXTENDED`**
(default on, `src/settings.ts` → `getPreferExtended()`):

- **Canonical selection** — `getAllEpisodes()` picks the extended CRC32 as canonical when the setting
  is on and one exists, else the standard. Coverage therefore flags a standard-on-disk as *upgradeable*
  to the extended cut even though the release dates match (selection is by variant, never by date).
  The derived list is cached per preference combination (extended × arabasta), cleared on metadata reload.
- **Pipeline guard** — `isPreferredRelease()` makes the RSS poll skip the non-preferred variant (see
  Pipeline step 1).
- **Filename tag** — `buildPlexFilename(..., extended)` appends `[Extended]` (e.g.
  `… [1080p][3B7CBD0F][Extended].mkv`). `extractCrc32FromFilename` takes the **last** 8-hex bracket so
  the trailing tag doesn't hide the CRC; it still parses the old scheme and raw source filenames.
- **Arabasta** — separate cosmetic preference **`PREFER_ARABASTA`** (default on): renders arc 14's
  dataset title "Alabasta" as "Arabasta" at the single arc-title emission point in `metadata.ts`, so
  coverage, generated filenames, the Normalize-naming targets, and Plex season titles all pick it up.

## Resolution Targeting

The metadata's canonical-release pointers (`standard`/`extended`) name **one CRC32 per episode**
(per cut), so an off-resolution torrent's CRC32 simply isn't the canonical one. The blessed release
is 1080p; the Plex filename's `[resolution]` tag is read from the torrent filename, defaulting to `1080p`.
(The full `episodes{}` map retains historical CRC32s, so any past release still resolves for coverage
and upgrade lookups.)

## Casting

One Pace has no TMDB/TVDB listing, so no cast. `src/casting.ts` `syncCast()` copies the original
series' **show-level** cast onto the One Pace show — Plex has no season-level cast field, and
episode-level only holds per-episode crew/guest, so the main voice cast lives at the show level and
is inherited by every episode in Plex's UI. Flow: `resolveShowRatingKeyByName(CAST_SOURCE_SHOW)` →
`getShowRoles` (top `CAST_LIMIT`) → `setShowCast(onePaceShowKey, roles)`. The write uses
`buildCastEditParams` (pure, unit-tested) mirroring `old_scripts/sync_cast_list.py`:
`actor[i].tag` = actor, `actor[i].role` = character, `actor.locked=1`, `type=2`. Gated on
**`SYNC_CAST`** (default on); no-ops (never throws) when disabled or the source show isn't in the
library. Runs as a step of **Full Plex sync** (`sync` action). The `actor[i].tag`/`.role` param
format is Plex-version-sensitive — if a write doesn't take, `buildCastEditParams` is the single
place to adjust (e.g. to `actor[i].tag.tag`).

## Metadata & Thumbnail Reconciliation (key feature)

Keeps Plex episode/season **titles, summaries, and thumbnails** rich and current with minimal work,
driven by source changes rather than blind full syncs. Lives in `src/metadata-audit.ts` backed by the
`plex_meta_state` table.

**State model** — one row per episode, keyed by `season_episode_id` (stable across re-releases,
unlike CRC32):
- `desired_hash` — sha1 of the dataset's `title` + `summary` (both observable from Plex, so drift
  detection is symmetric; air date is written but not hashed).
- `applied_hash` — the desired hash we last successfully pushed to Plex (NULL = never). **`desired !=
  applied` ⇒ needs a metadata sync.**
- `in_plex`, `has_thumb`, `plex_title`, `plex_rating_key`, `thumb_attempts`, timestamps.

**Why it's efficient/dynamic** — a source refresh (`data.min.json` ETag flip or a Google Sheet reload)
calls `markDirtyFromSource()`, which recomputes `desired_hash` for every episode with **no Plex
calls**. Only episodes whose canonical text actually changed end up with `desired != applied`, so the
dirty set is derived from the data change itself.

**Reconcile pass** (`reconcilePlexMetadata`, 2 Plex reads — `/children` + `/allLeaves` via
`scanPlexMetadata`):
- Per episode: recompute desired, observe Plex (title/summary/`thumb`/ratingKey), and **adopt**
  Plex's copy as applied when it already matches (so prior manual/full syncs don't re-push).
- Classify → `ok` / `missing` (blank summary or placeholder title) / `drifted` (present but ≠ dataset)
  / `not_in_plex`. Push title/summary for flagged episodes+seasons where we hold canonical data,
  using ratingKeys straight from the scan (`updateEpisodeInPlex`/`updateSeasonInPlex`), then
  `setAppliedMeta`.
- **Thumbnails (tiered):** episodes with no real `thumb` get generation attempts, spaced by
  `THUMB_RETRY_SPACING_MS` (30 min, `thumb_last_attempt_at`) because Plex generates asynchronously.
  Tier 1 (attempts < `THUMB_PLEX_ATTEMPT_CAP` = 3): ask Plex to regenerate — `refreshItem` (**PUT**
  `/refresh` + `force=1`; POST 404s) + `analyzeItem` (PUT `/analyze`, scrubber previews,
  non-fatal). Tier 2 (attempts 3–4, up to `THUMB_TOTAL_ATTEMPT_CAP` = 5): Plex keeps grabbing bad
  frames, so **generate the frame ourselves** — `src/thumb-generator.ts` runs ffmpeg over the
  library file (found by S##E##), samples 8 frames across the middle 12–88% of the runtime, scores
  each by pixel spread with a near-black/white brightness penalty, and uploads the winner via
  `uploadPoster` (bounded at `GENERATE_PER_PASS` = 5 per reconcile; ffmpeg ships in the Docker
  image, and the generator no-ops with a warning where ffmpeg is absent, e.g. local dev). Past the
  total cap the episode is written off (`thumbUnavailable`). `has_thumb` re-observed each scan;
  present ⇒ counter reset. `retryThumbnails()` (action `retry-thumbs`, "Retry thumbnails" button)
  resets all counters + the blank cache and reconciles immediately (restarting at tier 1).
- **Blank-frame detection:** Plex sometimes extracts a fade-to-black/white transition frame, so a
  "set" thumb can still be visually empty. `detectBlankThumbs` fetches each episode thumb tiny
  (64px via `/photo/:/transcode`, raw fallback), decodes it with `jpeg-js` (pure JS, no native dep),
  and flags it blank when max per-channel pixel stddev < `BLANK_STDDEV_THRESHOLD` (8) — blank ⇒
  treated as no thumbnail ⇒ regeneration path. Verdicts are cached per thumb **version**
  (`thumb_checked_path`/`thumb_blank`; the path embeds a timestamp that changes on regen), so only
  new/changed thumbs are analyzed (concurrency 6). Undecodable images are treated as real and
  re-tried next pass.
- Idempotent and restart-safe: state is persistent, so a failed push or a mid-way restart is picked
  up next pass; it converges. Re-audits at the end so the stored report reflects the fix.

**Posters** — reconcile also runs the ETag-conditional `syncPosters()` at most once per 24h (KV
`posters_reconcile_checked_at`; a manual Full Plex sync stamps the same clock), gated on
`AUTO_POSTERS` — so updated fan art flows in without a manual sync.

**Automatic** — gated by **`AUTO_RECONCILE`** (default on): `reconcilePlexMetadata({thumbnails:true})`
runs after every **Refresh Sources** (`runAction("refresh-sources")`) and after each **ingest**
(`processor` `_processDownloading`, when `completed > 0`). When off, source refreshes only
`markDirtyFromSource()` for a later manual **Reconcile**.

**Read-only audit** — `scanMetadataAudit()` runs the same observe+classify but performs **no** Plex
writes; it's the `metadata-scan` action and the dashboard's "Scan" button. The report (KV
`metadata_audit_report`) is a display cache; `plex_meta_state` is the source of truth. `Full Plex
sync` (`runMetadataSync`) remains the resync-everything hammer.

## Season Folder Format Detection

`detectSeasonFormat()` (boot) scans `MEDIA_PATH` and builds an `arcPart → folderName` cache from the
folders already on disk, also detecting zero-padding. `buildSeasonFolder` returns the exact on-disk
name for known seasons, falling back to the detected padding style for new ones. The user's library
uses **unpadded** folders (`Season 1 - Romance Dawn`).

## Dashboard

Single-page web UI on port `8282` (config `DASHBOARD_PORT`), for viewing logs and triggering
stages without touching the deployment stack manager.

- **Server** (`src/web/server.ts`) — native Node `http` (no express, small `Router` in
  `src/web/router.ts`). The dashboard **always starts**; auth is checked **per request** via
  `checkRequestAuth` so changes apply live. Routes: `GET /api/status` (includes `counts`,
  `coverageScannedAt`, `updateAvailable` — newest published version when newer than running — and
  per-episode `file_size`), `GET /api/logs`, `GET /api/logs/stream` (SSE),
  `POST /api/actions/<id>`, `POST /api/episodes/<crc32>/<action>`,
  `GET /api/metadata/<crc32>` (resolved episode for the compare modal),
  `GET /api/downloads/progress` (per-crc32 `{progress,dlspeed,eta,state,size}`; no-ops when nothing
  is downloading), `GET /api/coverage` + `POST /api/coverage/scan`,
  `GET /api/metadata-audit` + `POST /api/metadata-audit/scan` (metadata/thumbnail reconciliation
  report; the path avoids the `/api/metadata/:crc32` compare route),
  `GET /api/naming/candidates` + `POST /api/naming/normalize`,
  `GET /api/search/torrents?q=` (AnimeTosho/Nyaa search for manual source selection),
  `GET/POST /api/health/*`, settings + auth endpoints, plus static files from `public/`.
- **Auth** (`src/web/auth.ts`) — runtime-managed, stored in `kv` (`auth_hash`, `auth_enabled`):
  - Password is set/changed from the dashboard (UI → `POST /api/auth/password` → `hashToken`
    scrypt salted hash; plaintext never stored). `npm run hash-token` + env are an optional bootstrap.
  - **Precedence:** DB hash (UI) > env `DASHBOARD_TOKEN_HASH` > env `DASHBOARD_TOKEN`.
  - `auth_enabled` toggle (`POST /api/auth/toggle`); enabling is rejected without a password.
    Default: enabled iff a secret exists. With no secret the dashboard runs **open** (logged loud).
  - scrypt verify is cached by password fingerprint (slow hash runs once, not per request). HTTP
    **Basic auth — base64, not encrypted in transit**; front with TLS if exposed beyond LAN.
- **Actions** (`src/controls.ts`) — global: `refresh-sources` (clear metadata + sheet caches →
  `refreshMetadata` → eager sheet prefetch → `runCycle` → reconcile or `markDirtyFromSource` per
  `AUTO_RECONCILE`; also what the cron runs), `sync` ("Full Plex sync": `runMetadataSync` +
  ETag-aware `syncPosters` + `syncCast`; heavy, confirmation modal in the UI), `metadata-scan` (read-only audit →
  report), `metadata-sync` ("Reconcile": `reconcilePlexMetadata` — push flagged metadata + trigger
  thumbnails), `retry-failed`, `clear-done` (remove all `done` rows; files kept). All serialized
  behind one lock (`isBusy`/`withLock`) so manual triggers never overlap the cron cycle. Tracks last-run
  timestamps in `runtime`. `runNormalizeNaming(crc32s)` (also lock-held) renames files to the
  canonical scheme (see Coverage & Naming).
- **Logs** — `logger.ts` emits every line on an `EventEmitter` (`logBus`). `boot.ts` subscribes to
  persist into the `logs` table; the server subscribes to broadcast over SSE. The page loads history
  from `GET /api/logs`, then live-tails via SSE.

### Runtime Settings (`src/settings.ts`)

Settings editable live from the dashboard without a redeploy, each tagged with a **category**
(`service` | `preference`) that the UI groups into "System & Services" vs "Preferences":
- **service:** **POLL_CRON**, **POLL_ENABLED** (bool), **DOWNLOAD_CHECK_SECONDS**,
  **RSS_FEED_URL**, **DISCORD_WEBHOOK_URL**, **POSTER_REPO_RAW_BASE**, **ANIMETOSHO_API_KEY**,
  **ANIMETOSHO_BASE_URL**, **NYAA_BASE_URL**, **GOOGLE_SHEETS_API_KEY**, **CAST_SOURCE_SHOW**.
- **preference:** **AUTO_DOWNLOAD** (bool), **AUTO_POSTERS** (bool), **AUTO_RECONCILE** (bool),
  **SYNC_CAST** (bool), **PREFER_EXTENDED** (bool), **PREFER_ARABASTA** (bool).

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
- `upgrade` — queue the new (canonical) release for an upgradeable episode. Looks up the magnet:
  DB record → KV cache (`magnet:<crc32>`, populated by the coverage scan) → live RSS
  (`findMagnetByCrc32`) as a last resort; upserts and queues it.
- `download-source` — queue a torrent found via the AnimeTosho/Nyaa search (`src/torrent-search.ts`,
  surfaced at `GET /api/search/torrents?q=`); body carries `{source, title}`, resolution is read from
  the result's title. Used for upgradeable/missing episodes the RSS feed no longer carries.
- `resync` — re-push that one episode's metadata to Plex (`syncSingleEpisode`)
- `remove` — delete the DB row; body `{deleteFile:true}` also removes the media file
  (`deleteEpisodeFile`). If the episode is still in-flight, its torrent is cancelled (partial data
  dropped) so a stalled download fully resets and can be retried.

Pipeline-mutating actions (`download`/`retry`/`upgrade`/`remove`) call `refreshCoverageIfPresent`
so the coverage view reflects the change without a manual re-scan.

### Coverage & Naming

- **Coverage** (`src/coverage.ts`) — `scanCoverage()` walks `MEDIA_PATH` (by `S##E##` in the
  filename), diffs against `getAllEpisodes()` (the canonical, extended-aware list), and classifies
  each episode: `present` / `present_unknown` (no CRC in name) / `upgradeable` (disk CRC ≠ canonical)
  / `downloading` (canonical CRC is in the pipeline — pending/downloading/processing) / `missing`.
  For upgradeable, `hasMagnet` is set from the DB **or** the live RSS feed (`getRssMagnetMap`), and
  any found magnet is cached to KV (`magnet:<crc32>`) for a later one-click upgrade. The report is a
  single upserted KV row (`coverage_report`) plus a cheap `coverage_scanned_at` timestamp the status
  endpoint exposes so the frontend can auto-pull a fresh report when it changes. `refreshCoverageIfPresent()`
  re-scans only if a report already exists (used after ingest, RSS changes, and pipeline actions).
- **Naming** (`src/naming.ts`) — `scanNamingCandidates()` walks the library and returns files whose
  name ≠ canonical (`buildPlexFilename` from the file's CRC32 → authoritative arc/episode/extended,
  resolution kept from the existing name); files without a resolvable CRC32 are left alone.
  `applyNamingRenames(crc32s)` re-scans server-side (ignores client paths), renames, skips when the
  target exists, and keeps `episodes.final_filename` in sync. Driven via `runNormalizeNaming` (lock +
  Plex scan + coverage refresh).

### Frontend design

"Command deck" aesthetic (`frontend/src/app.css`). **Theming:** DaisyUI v5 with **all built-in
themes enabled** (`@plugin "daisyui" { themes: all; }` — v5 bundles only light/dark by default).
`frontend/src/lib/theme.ts` manages the preference (`auto`/`light`/`dark`/`other`, localStorage
`one-pace-theme`); `other` opens a dropdown of all 32 DaisyUI themes (`one-pace-theme-custom`).
`auto` follows `prefers-color-scheme`, falling back to dark. **Logo:** `frontend/src/lib/logo.ts` —
three hand-drawn SVGs in `frontend/public/logos/` (straw-hat, jolly-roger, devil-fruit), selectable
in Settings, used as favicon + navbar icon (localStorage `one-pace-logo`). An inline script in
`frontend/index.html` applies the stored theme **and** logo before first paint (FOUC prevention) —
keep it in sync with the stores' resolution logic. Custom CSS stays theme-agnostic: `.deck-card`
(blur), `.eyebrow` (color derives from `--color-base-content`). Self-hosted fonts via `@fontsource`
(bundled, no CDN): **Chakra Petch** (display) + **IBM Plex Sans/Mono** (body/data).

Components: `NewReleases` (hero — `available` releases with changelog + Download), `System`,
`Controls` (Refresh Sources / Retry failed, **Full Plex sync** with confirmation modal,
**Normalize File Naming** modal), `Library` (unified coverage + metadata/thumbnail card: one per-arc
foldout with coverage-colored chips and thumbnail dots, combined totals, Upgrade-Now batch modal,
re-release compare modal, find-source search, Scan-both + Reconcile), `WhatsNew` (post-update
changelog modal — CHANGELOG.md is bundled via a Vite `?raw` import, parsed client-side, and shown
once when the running version is newer than localStorage's last-seen version), `InfoCards`,
`Settings` (a `<dialog>` modal opened from the
navbar gear icon via the `settingsOpen` store — Appearance pickers, System & Services / Preferences
groups, and `Auth` as a sub-section), `Episodes` (pipeline table — newest-first, live download
progress + size, Clear done, per-row actions + remove-confirm modal), `Logs` (Clear + client-side
text/level filters), `Auth`,
`Toasts`, `Navbar` (logo, busy badge, uptime, settings gear).

### Frontend (`frontend/`)

Svelte 5 + Vite, daisyUI (Tailwind v4 via `@tailwindcss/vite`). Build-time only — the runtime image
ships just the compiled static output.

- `vite build` compiles `frontend/` → `public/` (hashed `assets/` + `index.html`). The Node server
  serves `public/` via `serveStatic`. `public/` is **generated and gitignored**.
- Config files are `.mts`/`.mjs` (`vite.config.mts`, `svelte.config.mjs`) so the ESM frontend
  tooling coexists with the CommonJS backend without setting `"type": "module"`.
- Components: `frontend/src/App.svelte` + `lib/` (`Navbar`, `System`, `Controls`, `Library`,
  `WhatsNew`, `InfoCards`, `Settings`, `Episodes`, `NewReleases`, `Logs`, `Auth`, `Toasts`); `lib/api.ts`
  (typed fetchers), `lib/stores.ts` (status/logs/toasts/coverage/downloadProgress/`settingsOpen`
  stores + SSE + `startProgressPolling`; auto-pulls coverage when `coverageScannedAt` advances),
  `lib/theme.ts` + `lib/logo.ts` (appearance preferences, localStorage-backed), `lib/util.ts`
  (`fmtBytes`/`fmtSpeed`/`fmtEta` etc.). Backend API is framework-agnostic — the frontend can be
  swapped without backend changes.
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
One Pace - {arcTitle} - S{part:02d}E{ep:02d} [{resolution}][{CRC32}][Extended].mkv   # extended cut
```
Note: the **filename** zero-pads S/E (Plex convention); the **folder** name does not. The optional
`[Extended]` tag is appended for extended cuts; `extractCrc32FromFilename` reads the last 8-hex
bracket so the tag never hides the CRC.

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
| `AUTO_POSTERS` | `true` | auto-apply a poster when a new season first appears (dashboard-editable) |
| `AUTO_RECONCILE` | `true` | auto-sync Plex metadata + thumbnails on source changes/ingest (dashboard-editable) |
| `SYNC_CAST` | `true` | copy the original series' cast onto the One Pace show during Full Plex sync (dashboard-editable) |
| `CAST_SOURCE_SHOW` | `One Piece` | the original series' show title in the same Plex library (dashboard-editable) |
| `CAST_LIMIT` | `30` | number of top-billed roles to copy (env-only) |
| `PREFER_EXTENDED` | `true` | prefer the extended cut when an episode has both (dashboard-editable) |
| `PREFER_ARABASTA` | `true` | render arc 14 "Alabasta" as "Arabasta" (dashboard-editable) |
| `DASHBOARD_TOKEN_HASH` | — (optional bootstrap) | scrypt hash; password is normally set in the UI |
| `DASHBOARD_TOKEN` | — (optional bootstrap) | plaintext password fallback; used only if no hash |
| `DASHBOARD_PORT` | `8282` | dashboard listen + published port |
| `METADATA_REPO_RAW_BASE` | ladyisatis v2 raw URL | the app fetches `${base}/metadata/data.min.json`; override only for a mirror |
| `GOOGLE_SHEETS_API_KEY` | — (optional) | enables the Google Sheets metadata supplement (dashboard-editable) |
| `ONEPACE_SHEET_ID` | official guide sheet | One Pace episode guide spreadsheet ID |
| `ONEPACE_METADATA_SHEET_ID` | maintainer's sheet | dataset maintainer's working spreadsheet ID |
| `ANIMETOSHO_API_KEY` | — (optional) | raises AnimeTosho rate limits (dashboard-editable) |
| `ANIMETOSHO_BASE_URL` | `https://feed.animetosho.xyz` | torrent search source (dashboard-editable) |
| `NYAA_BASE_URL` | `https://nyaa.si` | torrent search source (dashboard-editable) |

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
| `src/rss.ts` | RSS poll, CRC32 resolution, changelog extraction, cached feed + `getRssMagnetMap`/`findMagnetByCrc32` |
| `src/metadata.ts` | richer `metadata/data.min.json` fetch/cache, indexes, extended-aware lookups, filename build |
| `src/arc-titles.ts` | `canonicalizeArcTitle()` — folds arc-title spelling variants for cross-source matching |
| `src/onepace-sheet.ts` | official One Pace episode-guide Google Sheet (early CRC32 source; 6h cache) |
| `src/onepace-descriptions.ts` | maintainer's metadata Google Sheet (early titles/descriptions; 6h cache) |
| `src/torrent-search.ts` | AnimeTosho + Nyaa search for manual source selection |
| `src/qbittorrent.ts` | qBittorrent Web API client (progress: `dlspeed`/`eta`/`size`) |
| `src/fileops.ts` | Season-format detection, move/rename, re-release file swap, on-disk size (cached) |
| `src/coverage.ts` | Library coverage scan/diff, magnet caching, stored report + scanned-at |
| `src/metadata-audit.ts` | Metadata/thumbnail reconciliation engine (desired/applied state, dirty-marking, push + thumbnail generation) |
| `src/naming.ts` | Normalize-naming candidate scan + batch rename |
| `src/posters.ts` | Fan-made season/show poster sync (auto on new seasons; ETag-aware re-check daily via reconcile + Full Plex sync) |
| `src/casting.ts` | Copies the original series' show-level cast onto the One Pace show (see Casting) |
| `src/update-check.ts` | Update notifier — compares running version against main's package.json (6h cache) |
| `src/backup.ts` | Nightly SQLite backups to DATA_DIR/backups (04:00 + boot catch-up, keep 7) |
| `src/health.ts` | Health monitor (Plex/qBit/disk checks) for the System panel |
| `src/plex.ts` | Plex API (scan, lock-aware metadata update, single + full sync, `scanPlexMetadata`, `refreshItem`/`analyzeItem` for thumbnails) |
| `src/processor.ts` | Completion handler; coverage refresh on ingest; `runMetadataSync`/`retryFailed` (manual-only) |
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

- **Download sources are RSS magnets/torrents only** — a `magnet:` URI (preferred) or an http(s)
  `.torrent` URL fallback from each RSS item. No plain direct/HTTP file download. For torrent-URL
  adds the info hash is resolved by diffing qBit's torrent list (no `urn:btih:` to read), which
  assumes adds are serialized (they are — behind the action lock / sequential poll loop).
- **Plex baremetal routing** — `PLEX_URL` must be host IP/DNS, confirm container→host reachability.
- **Info hash resolution** — `qbittorrent.ts` reads the hash from `urn:btih:` for magnets; for
  torrent URLs / base32 magnets it diffs the category's torrent list after adding. If that diff finds
  nothing within ~5s the hash is `""` and completion detection for that item won't fire.
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
> `prepare` script) auto-bumps the patch version, **skipping the bump for docs-only commits**
> (changes confined to `*.md`, `docs/`, `.github/`, `.githooks/`) — note it cannot spawn under Git
> for Windows (shell-hook spawn issue), so on Windows the bump must be done manually (`npm version
> patch --no-git-tag-version`).

### Commit / CI policy

- Version bumps and Docker image builds are for **software changes only**. The pre-commit hook
  skips the bump for docs-only commits automatically, and `.github/workflows/docker.yml` has a
  matching `paths-ignore` so docs-only pushes to `main` don't rebuild the GHCR image.
- If a docs-only push must be extra-sure not to trigger CI, add `[skip ci]` to the commit message.
- **Tests** (`npm test`, Vitest) live in `test/` (kept out of `src/` so they never compile into
  `dist/` or the image; `.github/workflows/test.yml` runs typecheck + tests on every push/PR).
  They cover pure logic (filename build/parse, arc-title canonicalization, Discord embeds, version
  compare, blank-thumbnail pixel analysis) plus a processor regression guard (a slow reconcile must
  not block download-completion detection — the bug that silenced completion notifications). Add a
  test with new pure logic; keep flow tests mock-based rather than hitting real Plex/qBit/SQLite.
- **Changelog** (`CHANGELOG.md`, Keep a Changelog format): every user-facing change lands with an
  entry under `## [Unreleased]` in the same commit. Docs/CI/refactor-only commits are exempt.
  Because the hook bumps the patch version on every commit, there is **no** heading per patch —
  when a GitHub release is cut, roll Unreleased into a `## [X.Y.Z] — date` heading (and mirror the
  content in `.github/release-notes/vX.Y.Z.md` for the release workflow).

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
