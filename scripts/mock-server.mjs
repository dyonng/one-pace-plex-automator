// Mock backend for frontend development — no sqlite/Plex/qBittorrent.
// Serves the same API surface as src/web/server.ts with canned data, a live
// fake log stream, and interactive actions (toggle busy, bump timestamps).
//
// Run:  node scripts/mock-server.mjs      (or: npm run mock)
// Then: npm run dev:web                    (Vite HMR, proxies /api -> :8282)
//   or: npm run build && open http://localhost:8282  (tests the prod bundle)
//
// NOTE: unlike the real server, the mock has NO auth (frictionless local dev).

import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const PORT = process.env.MOCK_PORT ? Number(process.env.MOCK_PORT) : 8282;
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
};

const startedAt = Date.now();
const state = {
  busy: false,
  busyLabel: null,
  runtime: {
    startedAt,
    lastPollAt: startedAt - 1000 * 60 * 4,
    lastSyncAt: null,
    lastRefreshAt: startedAt - 1000 * 60 * 30,
    lastRetryAt: null,
  },
};

let episodes = [
  mkEp("AB12CD34", 12, 6, "Little Garden", "available", null, ["Changed ED to Shochi no Suke.", "Added Turkish subtitles."]),
  mkEp("99EE77FF", 13, 1, "Drum Island", "available", null, []),
  mkEp("BCE915AA", 12, 1, "Little Garden", "done", "[1080p][BCE915AA]"),
  mkEp("CA509241", 12, 4, "Little Garden", "done", "[1080p][CA509241]"),
  mkEp("15344804", 31, 45, "Dressrosa", "downloading", null),
  mkEp("DEADBEEF", 19, 10, "Enies Lobby", "failed", null),
];

function mkEp(crc32, part, ep, arc, status, tag, changelog = []) {
  const file = tag ? `One Pace - ${arc} - S${part}E${ep} ${tag}.mkv` : null;
  return {
    crc32,
    arc_part: part,
    episode_num: ep,
    arc_title: arc,
    status,
    resolution: "1080p",
    final_filename: file,
    original_filename: file ?? `[One Pace] ${arc} ${ep} [1080p][${crc32}].mkv`,
    changelog,
    error_message: status === "failed" ? "Downloaded file not found" : null,
    updated_at: Date.now() - Math.floor(Math.random() * 1000 * 60 * 60),
  };
}

function counts() {
  const c = {};
  for (const e of episodes) c[e.status] = (c[e.status] ?? 0) + 1;
  return c;
}

function buildStatus() {
  return {
    version: "0.1.1-mock",
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    busy: state.busy,
    busyLabel: state.busyLabel,
    schedule: { pollCron: "*/5 * * * *", downloadCheck: "30s" },
    runtime: state.runtime,
    metadata: { arcs: 37, episodes: 542 },
    plex: { plexUrl: "http://192.168.1.10:32400", libraryName: "TV Shows", showTitle: "One Pace" },
    config: {
      rssFeedUrl: "https://onepace.net/en/releases/rss.xml",
      qbitUrl: "http://qbittorrent:8080",
      qbitCategory: "one-pace",
      plexLibraryName: "TV Shows",
      discordConfigured: true,
    },
    counts: counts(),
    episodes,
  };
}

// ---- coverage (mock) ----
function mockCoverage() {
  const arcDefs = [
    [1, "Romance Dawn", "East Blue", 4],
    [2, "Orange Town", "East Blue", 3],
    [3, "Syrup Village", "East Blue", 5],
    [12, "Little Garden", "Paramount War", 6],
    [31, "Dressrosa", "Dressrosa", 45],
  ];
  const pick = (e, part) => {
    // deterministic-ish spread of statuses for the mock
    if (part === 31 && e > 40) return "missing";
    if (part === 12 && e === 6) return "upgradeable";
    if (part === 3 && e >= 4) return "missing";
    if (part === 2 && e === 3) return "present_unknown";
    return "present";
  };
  const arcs = arcDefs.map(([part, title, saga, total]) => {
    const episodes = [];
    let present = 0,
      missing = 0,
      upgradeable = 0;
    for (let e = 1; e <= total; e++) {
      const status = pick(e, part);
      if (status === "missing") missing++;
      else if (status === "upgradeable") upgradeable++;
      else present++;
      episodes.push({
        arcPart: part,
        episodeNum: e,
        seasonEpisodeId: `s${String(part).padStart(2, "0")}e${String(e).padStart(2, "0")}`,
        episodeTitle: `${title} ${e}`,
        datasetCrc32: "AAAA0000",
        status,
        diskFilename: status === "missing" ? null : `One Pace - ${title} - S${part}E${e} [1080p][AAAA0000].mkv`,
        diskCrc32: status === "missing" || status === "present_unknown" ? null : "AAAA0000",
      });
    }
    return { arcPart: part, arcTitle: title, arcSaga: saga, total, present, missing, upgradeable, episodes };
  });
  const totals = arcs.reduce(
    (t, a) => ({
      episodes: t.episodes + a.total,
      present: t.present + a.present,
      missing: t.missing + a.missing,
      upgradeable: t.upgradeable + a.upgradeable,
    }),
    { episodes: 0, present: 0, missing: 0, upgradeable: 0 }
  );
  return {
    scannedAt: Date.now(),
    mediaPath: "/media/one-pace",
    mediaPathExists: true,
    totals,
    arcs,
    extras: ["One Pace - Movie - Strong World [1080p][DEADBEEF].mkv"],
  };
}

// Latest stored coverage report (null until first scan), mirroring the kv row.
let lastCoverage = null;

// ---- fake log stream ----
const sseClients = new Set();
let logId = 0;

function broadcast(entry) {
  const line = `data: ${JSON.stringify(entry)}\n\n`;
  for (const res of sseClients) res.write(line);
}

function emitLog(level, msg, meta) {
  const entry = { ts: Date.now(), level, msg, meta };
  recentLogs.push(entry);
  if (recentLogs.length > 1000) recentLogs.shift();
  broadcast(entry);
  return entry;
}

const recentLogs = [];
// Seed some history
emitLog("info", "Boot complete", { version: "0.1.1-mock" });
emitLog("info", "Dashboard listening", { port: PORT });
emitLog("debug", "Metadata unchanged (304)");

// Periodic chatter so the live tail visibly updates
const CHATTER = [
  ["info", "Starting RSS poll cycle"],
  ["debug", "RSS feed unchanged (304), skipping"],
  ["info", "Still downloading", { crc32: "15344804", hash: "abcd…" }],
  ["warn", "qBittorrent slow to respond", { ms: 4200 }],
];
setInterval(() => {
  const [lvl, msg, meta] = CHATTER[logId++ % CHATTER.length];
  emitLog(lvl, msg, meta);
}, 3000);

// ---- settings (mock) ----
const SETTING_ENV = {
  POLL_CRON: "*/5 * * * *",
  DOWNLOAD_CHECK_SECONDS: "30",
  AUTO_DOWNLOAD: "false",
  DISCORD_WEBHOOK_URL: "",
  RSS_FEED_URL: "https://onepace.net/en/releases/rss.xml",
};
const SETTING_LABEL = {
  POLL_CRON: "RSS poll schedule (cron)",
  DOWNLOAD_CHECK_SECONDS: "Download check interval (seconds)",
  AUTO_DOWNLOAD: "Auto-download new releases",
  DISCORD_WEBHOOK_URL: "Discord webhook URL (blank = off)",
  RSS_FEED_URL: "RSS feed URL",
};
const SETTING_TYPE = {
  POLL_CRON: "cron",
  DOWNLOAD_CHECK_SECONDS: "int",
  AUTO_DOWNLOAD: "bool",
  DISCORD_WEBHOOK_URL: "url_or_empty",
  RSS_FEED_URL: "url",
};
const settingOverrides = {};

function describeSettings() {
  return Object.keys(SETTING_ENV).map((key) => ({
    key,
    label: SETTING_LABEL[key],
    type: SETTING_TYPE[key],
    value: settingOverrides[key] ?? SETTING_ENV[key],
    envValue: SETTING_ENV[key],
    overridden: key in settingOverrides,
  }));
}

function applySetting(key, value) {
  if (!(key in SETTING_ENV)) return { ok: false, message: `Unknown setting: ${key}` };
  if (SETTING_TYPE[key] === "int" && !Number.isInteger(Number(value)))
    return { ok: false, message: "Must be a whole number" };
  settingOverrides[key] = String(value);
  emitLog("info", `Setting updated: ${SETTING_LABEL[key]}`, { value });
  return { ok: true, message: `${SETTING_LABEL[key]} updated` };
}

function resetSetting(key) {
  if (!(key in SETTING_ENV)) return { ok: false, message: `Unknown setting: ${key}` };
  delete settingOverrides[key];
  return { ok: true, message: `${SETTING_LABEL[key]} reset to env default` };
}

// ---- auth (mock, in-memory) ----
const authState = { enabled: false, hasPassword: false };

function setMockPassword(pw) {
  if (!pw || pw.length < 6) return { ok: false, message: "Password must be at least 6 characters" };
  authState.hasPassword = true;
  return { ok: true, message: "Password updated" };
}

function setMockAuthEnabled(enabled) {
  if (enabled && !authState.hasPassword) return { ok: false, message: "Set a password before enabling authentication" };
  authState.enabled = enabled;
  return { ok: true, message: enabled ? "Authentication enabled" : "Authentication disabled" };
}

// ---- actions ----
const ACTION_MSG = {
  poll: "RSS poll cycle complete",
  sync: "Full Plex metadata sync complete",
  "refresh-metadata": "Metadata cache refreshed",
  "retry-failed": "Failed episodes re-queued",
};

async function runMockAction(id) {
  if (!(id in ACTION_MSG)) return { status: 404, body: { ok: false, message: "Unknown action" } };
  if (state.busy) return { status: 409, body: { ok: false, message: `Busy: "${state.busyLabel}"` } };

  const labels = { poll: "Poll RSS", sync: "Full Plex sync", "refresh-metadata": "Refresh metadata", "retry-failed": "Retry failed" };
  state.busy = true;
  state.busyLabel = labels[id];
  emitLog("info", `Manual action: ${labels[id]}`);

  await new Promise((r) => setTimeout(r, 1500)); // simulate work

  if (id === "poll") state.runtime.lastPollAt = Date.now();
  if (id === "sync") state.runtime.lastSyncAt = Date.now();
  if (id === "refresh-metadata") state.runtime.lastRefreshAt = Date.now();
  if (id === "retry-failed") {
    state.runtime.lastRetryAt = Date.now();
    for (const e of episodes) if (e.status === "failed") e.status = "pending";
  }
  state.busy = false;
  state.busyLabel = null;
  emitLog("info", ACTION_MSG[id]);
  return { status: 200, body: { ok: true, message: ACTION_MSG[id] } };
}

// ---- http ----
function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => {
      try {
        resolve(d ? JSON.parse(d) : {});
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

function serveStatic(res, file) {
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR)) return res.writeHead(403).end();
  fs.readFile(full, (err, data) => {
    if (err) return res.writeHead(404).end("Not found (run `npm run build` to generate public/)");
    res.writeHead(200, { "Content-Type": MIME[path.extname(full)] ?? "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = req.url ?? "/";
  const method = req.method ?? "GET";

  if (url.startsWith("/api/")) {
    if (method === "GET" && url.startsWith("/api/health"))
      return sendJson(res, 200, { ok: true, version: "0.1.2-mock", uptimeSec: Math.floor(process.uptime()) });
    if (method === "GET" && url.startsWith("/api/status")) return sendJson(res, 200, buildStatus());
    if (method === "GET" && url.startsWith("/api/logs/stream")) {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.write("retry: 3000\n\n");
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }
    if (method === "GET" && url.startsWith("/api/logs")) return sendJson(res, 200, recentLogs);
    if (method === "POST" && url.startsWith("/api/coverage/scan")) {
      await new Promise((r) => setTimeout(r, 600)); // simulate scan
      lastCoverage = mockCoverage();
      emitLog("info", "Coverage scan complete", lastCoverage.totals);
      return sendJson(res, 200, lastCoverage);
    }
    if (method === "GET" && url.startsWith("/api/coverage")) return sendJson(res, 200, lastCoverage);
    if (method === "POST" && url.startsWith("/api/actions/")) {
      const id = url.split("/").pop().split("?")[0];
      const { status, body } = await runMockAction(id);
      return sendJson(res, status, body);
    }
    if (method === "POST" && url.startsWith("/api/episodes/")) {
      const [crc32, action] = url.replace(/^\/api\/episodes\//, "").split("?")[0].split("/");
      const ep = episodes.find((e) => e.crc32 === crc32);
      if (!ep || !["download", "retry", "resync", "remove"].includes(action))
        return sendJson(res, 404, { ok: false, message: "Unknown episode action" });
      if (action === "download" || action === "retry") {
        ep.status = "downloading";
        ep.updated_at = Date.now();
        emitLog("info", `Episode download started: S${ep.arc_part}E${ep.episode_num}`, { crc32 });
        return sendJson(res, 200, { ok: true, message: `Download started: S${ep.arc_part}E${ep.episode_num}` });
      }
      if (action === "resync") {
        emitLog("info", `Re-synced S${ep.arc_part}E${ep.episode_num} to Plex`);
        return sendJson(res, 200, { ok: true, message: `Re-synced S${ep.arc_part}E${ep.episode_num} to Plex` });
      }
      if (action === "remove") {
        const b = await readBody(req);
        episodes = episodes.filter((e) => e.crc32 !== crc32);
        return sendJson(res, 200, { ok: true, message: `Removed S${ep.arc_part}E${ep.episode_num}${b?.deleteFile ? " + file" : ""}` });
      }
    }
    if (method === "GET" && url.startsWith("/api/auth")) return sendJson(res, 200, authState);
    if (method === "POST" && url.startsWith("/api/auth/password")) {
      const b = await readBody(req);
      const r = setMockPassword(b?.password ?? "");
      return sendJson(res, r.ok ? 200 : 400, r);
    }
    if (method === "POST" && url.startsWith("/api/auth/toggle")) {
      const b = await readBody(req);
      const r = setMockAuthEnabled(Boolean(b?.enabled));
      return sendJson(res, r.ok ? 200 : 400, r);
    }
    if (method === "GET" && url.startsWith("/api/settings")) return sendJson(res, 200, describeSettings());
    if (method === "POST" && url.startsWith("/api/settings/reset")) {
      const b = await readBody(req);
      return sendJson(res, 200, resetSetting(b?.key));
    }
    if (method === "POST" && url.startsWith("/api/settings")) {
      const b = await readBody(req);
      const r = applySetting(b?.key, b?.value ?? "");
      return sendJson(res, r.ok ? 200 : 400, r);
    }
    return sendJson(res, 404, { ok: false, message: "Not found" });
  }

  if (method === "GET") {
    const file = url === "/" ? "index.html" : url.replace(/^\//, "").split("?")[0];
    return serveStatic(res, file);
  }
  res.writeHead(405).end();
});

server.listen(PORT, () => {
  console.log(`[mock] backend on http://localhost:${PORT}  (no auth)`);
  console.log(`[mock] frontend dev:  npm run dev:web   (Vite proxies /api here)`);
});
