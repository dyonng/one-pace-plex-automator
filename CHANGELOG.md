# Changelog

All notable changes to One Pace Plex Automator are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Patch versions are bumped automatically on every software commit (see
`.githooks/pre-commit`), so entries are grouped by feature milestone rather
than one heading per patch. New work is added under **Unreleased** and rolled
into a version heading when a GitHub release is cut.

## [Unreleased]

### Added
- **Specials support.** The One Pace **Specials** arc (dataset arc part 0 — the
  animated specials, including *One Piece Fan Letter*) is no longer skipped. It
  now flows through coverage, metadata reconciliation, and Full Plex sync like
  any other season, landing in Plex's native Season 0 / Specials. The specials
  poster was already wired up, so it applies automatically.

- **"One Piece Fan Letter" is now downloadable.** Its feed title isn't an arc
  name, so neither the dataset nor the episode guide could ever place it by
  title, and its re-cuts ship CRC32s the dataset may not list for a long time — so
  it failed on every poll. A small alias table now pins any Fan Letter release to
  **Specials S00E98**, the slot where the catalog already stores its title and
  description, so it downloads and picks that metadata up automatically.

- **Poster sets** (`POSTER_SET`, dashboard-editable under Preferences) — five
  collections to choose from: SpykerNZ and its alternate show design, plus
  piratezekk, mizzoufan523 and Official (via eltharynd/OnePacerr). The Settings
  picker previews each set's art rather than asking for an id.
  **Every set is uploaded to Plex**, so Plex's own poster picker lists them all
  and you can switch there too; the set you choose is uploaded last, which is
  what makes it the selected one. Sets with gaps (mizzoufan523 has no show
  poster, Official is missing a few seasons) are skipped for those targets.
  A legacy `SHOW_POSTER_VARIANT` of `1`/`2` migrates automatically.

- **Re-apply posters** button (Library card) — forgets which posters are recorded
  as applied and uploads them all again. The escape hatch for when Plex is
  missing art the app believes it already set.

- **The feed's publication date is now kept** (`published_at`, normalized to
  `YYYY-MM-DD`). It was parsed and discarded. It's used as the air date for an
  episode the catalog doesn't list yet, so Plex gets a real date instead of a
  blank; once the dataset publishes the episode, reconcile replaces it with the
  dataset's own date. Existing databases get the column automatically.

- **OnePacerr API as a third metadata source** (`USE_ONEPACERR`, on by default,
  dashboard-editable). It scrapes the same RSS feed and Google Sheets we do, but
  server-side and continuously, so it often knows a release before the ladyisatis
  dataset regenerates. It's consulted **only after** the dataset and the episode
  guide come up empty, and every failure is swallowed — a gap-filler, never a
  dependency. It resolves *One Piece Fan Letter*'s CRC32, which neither of our
  own sources lists. Its episode numbering can disagree with the catalog (it
  files Fan Letter as S00E01 where the catalog uses S00E98), so aliased releases
  are remapped onto the catalog's slot to avoid the same episode landing twice.

- **`PLEX_SHOW_TITLE`** — the Plex show title was hardcoded to "One Pace", so
  anyone who named the show differently hit a hard failure on startup. It's now
  configurable, and the error names the library and the setting when the show
  isn't found.

### Removed
- **Reset cast** action and its button. Cast sync was removed in 1.1.9, so
  nothing can create the bare actor tags it cleaned up; it was a one-time
  migration tool for pre-1.1.9 installs. Stray tags can still be removed from
  Plex's own Edit → Cast.

### Fixed
- **The thumbnail diagnostic was unreachable.** Blank-frame verdicts are cached
  per detector version, so once a scan had run nothing was re-measured and the
  analysis log reported no numbers — while the one control that clears that
  cache, **Retry thumbnails**, was hidden unless something was already flagged.
  The button is now always shown, and the detector version was bumped so the next
  scan re-measures every thumbnail.

- **A newer-than-the-catalog file was offered as an "upgrade" — which would have
  downgraded it.** Any CRC32 mismatch between disk and the dataset's canonical
  release was treated as upgradeable. But the dataset retains historical CRC32s,
  so a mismatch is only genuinely out of date when the on-disk release is one the
  catalog *knows*. A CRC32 the catalog has never seen came from a release that
  landed before the dataset regenerated — i.e. it's newer. Those now report as
  **present (not in catalog yet)** instead of prompting an update that would
  replace the newer file with an older one.
- **A poster that never actually took would be skipped forever.** Poster sync
  trusted its own "already applied" record: once an ETag was stored, every later
  sync sent a conditional request, got `304 Not Modified`, and skipped the target
  — even while Plex showed no art (visible as `applied:0, skipped:38`). It now
  reads Plex's actual poster state per target and ignores the cached ETag when the
  art isn't there, so a silently-failed upload self-heals on the next sync.
- **A brand-new season could end up with no poster.** After an ingest created a
  season (e.g. the first special creating Season 0), the poster step looked the
  season up in Plex immediately — but the library scan that creates it runs
  asynchronously, so the lookup often missed and the function returned *silently*.
  It now polls for the season before giving up, and logs when it does, instead of
  failing invisibly. (A Full Plex sync always applied the art after the fact.)
- **Blown-out / faded thumbnails are now detected.** Blank-frame detection only
  caught single-colour stills, so a fade-to-white flash with a silhouette in it
  had enough colour spread to pass as a real frame. Frames whose pixels are almost
  entirely clipped to black or white are now treated as unusable and regenerated
  like any other blank thumbnail. The detector version was bumped so existing
  thumbnails are re-evaluated.
- **A release whose CRC32 isn't catalogued yet no longer dead-ends.** Previously
  an RSS entry carrying a real-but-unpublished CRC32 (common when a release lands
  before the metadata dataset and episode guide regenerate) failed with
  `CRC32 … not found in metadata dataset` and was skipped outright. It now falls
  through to the same provisional path used for entries with no CRC32, so it can
  still be identified from its title and downloaded. If the provisional path
  can't place it either, the feed item is deliberately left unmarked so a later
  poll picks it up once the sources catch up — rather than being dropped.

## [1.1.14] — 2026-07-25

### Fixed
- **Doubled "v" in the qBittorrent version** shown in the System panel (e.g.
  `vv5.2.3`) — qBittorrent's version string already includes a leading `v`, so
  the health check no longer adds its own.

## [1.1.13] — 2026-07-25

Adds Discord health alerts and a dedicated notifications settings section, then
tames the alerting so it only fires on real, sustained problems.

### Fixed
- **Spurious "dataset not loaded yet" health alerts on every source refresh.**
  Refresh Sources cleared the in-memory metadata dataset *before* re-fetching it,
  so a health check landing in that window reported the dataset as unloaded and
  fired a Discord warning (then a recovery a minute later). The cache is now
  invalidated by resetting only its ETag — the current dataset stays live and is
  swapped atomically once the fresh copy loads, so there's no unloaded window
  (and a failed refresh keeps serving the last-good data instead of nulling it).
- **Health alerts are now debounced.** A status must persist across two
  consecutive checks before it alerts, and a recovery is only sent if a problem
  was actually announced — so transient blips can't page you.

### Added
- **Discord Notifications settings section** — a dedicated Settings group holding
  the Discord webhook (moved here from System & Services) plus per-event toggles:
  new episode detected, episode downloaded & imported, episode updated
  (re-release), processing errors, and health alerts. All default on and no-op
  without a webhook.
- **Health alerts to Discord** — the health monitor already knew when Plex or
  qBittorrent went unreachable, a disk got low, or items were failing, but only
  showed it on the dashboard. It now sends a Discord alert when the overall
  status **changes** into a warning/error state (with the failing checks listed)
  and a recovery message when it clears. Change-only + a short boot grace window
  mean no steady-state spam and no restart false alarms. Gated on `NOTIFY_HEALTH`.

## [1.1.10] — 2026-07-23

Richer Plex presentation for the agent-less show, and the removal of cast sync
(which can't work on a fan edit).

### Added
- **Show-level metadata** — the One Pace show now gets genres (Anime, Action,
  Adventure, Fantasy, Comedy), a content rating (TV-14), and a studio (Toei
  Animation) written as locked fields, so an agent-less show stops reading as
  "Not Rated / unknown" and shows up in Plex's genre-based discovery. Applied on
  Full Plex sync and re-asserted once a day during reconcile (read-compare, so it
  only writes when Plex is missing them).
- **Season air dates** — each season (arc) now gets `originallyAvailableAt` set
  to its earliest episode's release date.

### Changed
- **Air-date drift now self-heals.** Episode air dates are part of the
  reconcile identity hash (alongside title + summary), so an episode that gains a
  release date in the dataset later — or is missing one in Plex — gets it
  backfilled automatically instead of only on the initial sync. Dates that don't
  normalize to `YYYY-MM-DD` are ignored for drift to avoid needless re-writes.
- **Reset cast** action/button retained as a cleanup tool — removes any bare
  actor tags left on the One Pace show by earlier cast-sync attempts. Only ever
  touches One Pace; recover the source series in Plex with Fix Match + Clean
  Bundles + Optimize Database.

### Removed
- **Cast sync** — removed entirely (the `SYNC_CAST` / `CAST_SOURCE_SHOW` /
  `CAST_LIMIT` settings and the cast-copy step of Full Plex sync). Plex can only
  add bare, unlinked actor-name tags to an agent-less fan-edit show — no
  characters, no photos, no person-linking (that comes only from agent matching,
  which One Pace has no access to). Worse, the bare tags collide with the source
  series' real cast, leaving its cast view broken. There is no working path to
  proper cast on this show via the Plex API, so the feature is gone.

## [1.1.2] — 2026-07-22

Reliability release: fixes a notification regression and adds the first
automated test coverage.

### Added
- **Unit tests** (Vitest) covering the pure logic most prone to silent
  regressions — filename building/parsing, arc-title canonicalization, Discord
  embed content, version comparison, and blank-thumbnail pixel analysis — plus a
  regression guard proving a slow reconcile can't block download-completion
  detection. Run with `npm test`; also runs in CI on every push.

### Fixed
- **Download-complete / Episode-updated Discord notifications** could stop
  firing: the post-ingest reconcile (a heavy, minutes-long pass) ran inside the
  download-check guard, so while it ran, completed downloads weren't detected —
  and detection is what sends those notifications. The reconcile now runs
  outside that guard, so completions are always detected and notified promptly.

## [1.1.0] — 2026-07-20

Quality-of-life release: self-describing updates, automated upkeep, and a
mobile-friendly dashboard.

### Added
- **What's New modal** — after an update, the dashboard greets you once with
  the changelog entries added since your last visit (last-seen version is
  remembered per browser).
- The navbar version badge is clickable and opens the full changelog anytime.
- **Update notifier** — the version button glows with a pulsing dot when a
  newer image has been published (checked against the repo every 6 hours).
- **Automatic poster updates** — reconcile now re-checks the fan-made poster
  repo daily (ETag-conditional, so unchanged art costs nothing) and applies any
  updated posters; previously that only happened during a manual Full Plex sync.
- **Nightly database backups** — the SQLite state is copied to
  `/data/backups/` every night at 04:00 (plus on startup when the newest backup
  is older than a day), keeping the last 7.
- **Log filtering** — the Logs panel gained a text filter and a level selector
  (Info+ / Warn+ / Errors), applied client-side over the live tail.
- **Mobile-friendly dashboard** — the pipeline table collapses low-value
  columns on small screens (with a compact download-progress readout), the
  release compare modal stacks vertically, and the dashboard is installable to
  a phone home screen (web app manifest + theme color).

## [1.0.10 – 1.0.18] — 2026-07-17

Thumbnail quality: detection and generation.

### Added
- **Blank-thumbnail detection** — episode thumbnails are fetched (64px via the
  photo transcoder, raw fallback) and pixel-analyzed; single-color fade frames,
  transparent PNGs, undecodable images, and dangling 404 references are all
  treated as missing so they get regenerated. Verdicts are cached per thumbnail
  version, so steady-state scans do no image fetching.
- **ffmpeg thumbnail generation** — when Plex's own regeneration keeps
  producing a bad frame (first 3 attempts), the tool samples 8 frames across
  the middle of the episode, scores them by detail with a brightness penalty,
  and uploads the best one as the episode thumbnail (attempts 4–5). ffmpeg is
  included in the Docker image.
- **Retry thumbnails** button — resets attempt counters and the analysis cache,
  re-requesting generation for everything still missing a thumbnail.

### Fixed
- Plex refresh calls used POST and 404'd — the endpoint is a PUT; per-item
  refresh now also sends `force=1` so artwork is re-acquired.
- Thumbnail generation attempts were burned before Plex's async queue could
  work: attempts are now spaced 30 minutes apart.
- Episode-chip tooltips were clipped by the arc container's `overflow-hidden`.

## [1.0.4 – 1.0.9] — 2026-07-17

Metadata reconciliation engine and dashboard consolidation.

### Added
- **Persistent metadata/thumbnail reconciliation** (`plex_meta_state` table) —
  tracks desired vs. applied metadata per episode; a source refresh marks only
  the episodes whose canonical text changed, and a reconcile pushes exactly
  those (plus triggers thumbnail generation) instead of a full-library sync.
  Runs automatically after Refresh Sources and after each ingest
  (`AUTO_RECONCILE` setting, default on).
- **Library card** — Coverage and Metadata & Thumbnails merged into one
  section: a single per-arc foldout with coverage-colored chips, thumbnail
  indicators, combined totals, and Scan/Reconcile controls.
- Detailed DaisyUI tooltips on all manual control buttons and episode chips.

### Fixed
- Coverage/Metadata buttons no longer 409 when a background action holds the
  action lock (they now respect the global busy state).
- The version-bump hook keeps `package-lock.json` in step with `package.json`.

## [1.0.1 – 1.0.3] — 2026-07-17

### Added
- **Metadata audit** — diffs Plex's episode/season titles and summaries against
  the One Pace dataset (2 Plex requests total), classifying each episode as
  ok / missing / drifted / not-in-Plex, with a dashboard card and targeted
  "sync only what's flagged" action.

## [1.0.0] — 2026-06-10

First stable release. See the
[release notes](.github/release-notes/v1.0.0.md) for the full feature list.

### Highlights
- Automated One Pace pipeline: RSS polling, qBittorrent dispatch, canonical
  renaming, Plex placement with re-release replacement, per-episode metadata
  sync, fan-made posters, Discord notifications.
- Web dashboard: live logs, pipeline with download progress, library coverage
  report with one-click upgrades, health panel, runtime settings, Basic auth.
- Extended-cut support, Google Sheets metadata supplements, AnimeTosho/Nyaa
  manual source search, Normalize File Naming.
- Appearance: light/dark/auto plus all DaisyUI themes, selectable logo.
- Docker images tagged per release version; GitHub releases automated.

## [0.1.x] — 2026

Pre-1.0 development: the core pipeline (RSS → qBittorrent → rename → Plex),
re-release detection, coverage reporting, the Svelte dashboard, runtime
settings, auth, health checks, posters, and the batch upgrade flow.
