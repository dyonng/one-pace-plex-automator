# Changelog

All notable changes to One Pace Plex Automator are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Patch versions are bumped automatically on every software commit (see
`.githooks/pre-commit`), so entries are grouped by feature milestone rather
than one heading per patch. New work is added under **Unreleased** and rolled
into a version heading when a GitHub release is cut.

## [Unreleased]

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
