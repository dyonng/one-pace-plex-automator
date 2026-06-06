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

const episodes = [
  mkEp("BCE915AA", 12, 1, "Little Garden", "done", "[1080p][BCE915AA]"),
  mkEp("CA509241", 12, 4, "Little Garden", "done", "[1080p][CA509241]"),
  mkEp("15344804", 31, 45, "Dressrosa", "downloading", null),
  mkEp("DEADBEEF", 19, 10, "Enies Lobby", "failed", null),
  mkEp("F00DCAFE", 12, 5, "Little Garden", "pending", null),
];

function mkEp(crc32, part, ep, arc, status, tag) {
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
    if (method === "GET" && url.startsWith("/api/status")) return sendJson(res, 200, buildStatus());
    if (method === "GET" && url.startsWith("/api/logs/stream")) {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.write("retry: 3000\n\n");
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }
    if (method === "GET" && url.startsWith("/api/logs")) return sendJson(res, 200, recentLogs);
    if (method === "POST" && url.startsWith("/api/actions/")) {
      const id = url.split("/").pop().split("?")[0];
      const { status, body } = await runMockAction(id);
      return sendJson(res, status, body);
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
