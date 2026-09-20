import http from "http";
import fs from "fs";
import path from "path";
import { getConfig } from "../config";
import { logger, logBus, LogEntry } from "../logger";
import { getRecentLogs, listEpisodes, countByStatus, getEpisodesByStatus, getEpisodeByCrc32 } from "../db";
import { getData, resolveEpisodeByCrc32 } from "../metadata";
import { resolvePlexConnection } from "../plex";
import { runtime, isBusy, busyLabel, runAction, runEpisodeAction, runBulkEpisodeAction, runNormalizeNaming, ActionId, EpisodeActionId, BulkEpisodeActionId, BULK_EPISODE_ACTIONS } from "../controls";
import { scanNamingCandidates } from "../naming";
import { describeSettings, applySetting, resetSetting, getSettingValue } from "../settings";
import { sendDiscordTest } from "../discord";
import { describePosterSets } from "../poster-sets";
import { scanCoverage, getStoredCoverage, getCoverageScannedAt } from "../coverage";
import { scanMetadataAudit, getStoredAudit, getAuditScannedAt } from "../metadata-audit";
import { getUpdateAvailable } from "../update-check";
import { searchTorrents } from "../torrent-search";
import { getQbitClient } from "../qbittorrent";
import { getEpisodeFileSize } from "../fileops";
import { getStoredHealth, runHealthCheck } from "../health";
import { checkRequestAuth, getAuthState, setPassword, setAuthEnabled, isAuthEnabled } from "./auth";
import { Router } from "./router";
import { version } from "../../package.json";

const PUBLIC_DIR = path.join(__dirname, "..", "..", "public");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".svg": "image/svg+xml",
};

const ACTION_IDS: ActionId[] = [
  "refresh-sources",
  "sync",
  "metadata-scan",
  "metadata-sync",
  "retry-thumbs",
  "resync-posters",
  "retry-failed",
  "clear-done",
];
const EPISODE_ACTIONS: EpisodeActionId[] = ["download", "retry", "resync", "remove", "upgrade", "download-source"];

function serveStatic(res: http.ServerResponse, urlPath: string): void {
  const file = urlPath === "/" ? "index.html" : urlPath.replace(/^\//, "");
  const full = path.join(PUBLIC_DIR, file);
  // Prevent path traversal — resolved path must stay under PUBLIC_DIR.
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404).end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(full)] ?? "application/octet-stream" });
    res.end(data);
  });
}

async function buildStatus() {
  let meta: { arcs: number; episodes: number } | null = null;
  try {
    meta = await getData();
  } catch {
    meta = null;
  }

  let plex: { plexUrl: string; libraryName: string; showTitle: string } | null = null;
  try {
    plex = await resolvePlexConnection();
  } catch {
    plex = null;
  }

  const cfg = getConfig();
  return {
    version,
    uptimeSec: Math.floor(process.uptime()),
    busy: isBusy(),
    busyLabel: busyLabel(),
    schedule: {
      pollCron: getSettingValue("POLL_CRON"),
      downloadCheck: `${getSettingValue("DOWNLOAD_CHECK_SECONDS")}s`,
    },
    runtime,
    metadata: meta,
    plex,
    config: {
      rssFeedUrl: cfg.RSS_FEED_URL,
      qbitUrl: cfg.QBIT_URL,
      qbitCategory: cfg.QBIT_CATEGORY,
      plexLibraryName: cfg.PLEX_LIBRARY_NAME,
      discordConfigured: Boolean(cfg.DISCORD_WEBHOOK_URL),
    },
    counts: countByStatus(),
    coverageScannedAt: getCoverageScannedAt(),
    metadataAuditScannedAt: getAuditScannedAt(),
    updateAvailable: getUpdateAvailable(),
    episodes: listEpisodes().map((e) => ({
      ...e,
      file_size: getEpisodeFileSize(e.arc_title, e.arc_part, e.final_filename),
    })),
  };
}

function streamLogs(req: http.IncomingMessage, res: http.ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write("retry: 3000\n\n");

  const onLog = (entry: LogEntry) => res.write(`data: ${JSON.stringify(entry)}\n\n`);
  logBus.on("log", onLog);
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 25_000);

  const cleanup = () => {
    clearInterval(heartbeat);
    logBus.off("log", onLog);
  };
  req.on("close", cleanup);
  res.on("error", cleanup);
}

/**
 * Identifies who is driving a mutating request, for the log trail. Destructive
 * actions used to log only their effect, so a mass removal left no record of what
 * triggered it — undiagnosable without asking the operator.
 */
function requestClient(req: http.IncomingMessage): string {
  const fwd = req.headers["x-forwarded-for"];
  const ip = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0].trim() || req.socket.remoteAddress || "unknown";
  const ua = req.headers["user-agent"];
  return `${ip} (${typeof ua === "string" && ua ? ua.slice(0, 80) : "no user-agent"})`;
}

export function buildRouter(): Router {
  const r = new Router();
  r.get("/api/status", async (c) => c.json(200, await buildStatus()));
  r.get("/api/logs", (c) => c.json(200, getRecentLogs(500)));

  // GET returns the last stored scan (cheap, survives restarts); POST runs a
  // fresh disk scan and overwrites the stored report.
  r.get("/api/coverage", (c) => c.json(200, getStoredCoverage()));
  r.post("/api/coverage/scan", async (c) => {
    try {
      c.json(200, await scanCoverage());
    } catch (err) {
      c.json(500, { ok: false, message: (err as Error).message });
    }
  });

  // Metadata audit: GET the last stored report; POST runs a fresh audit against
  // Plex. (Path avoids /api/metadata/:crc32 below.)
  r.get("/api/metadata-audit", (c) => c.json(200, getStoredAudit()));
  r.post("/api/metadata-audit/scan", async (c) => {
    try {
      c.json(200, await scanMetadataAudit());
    } catch (err) {
      c.json(500, { ok: false, message: (err as Error).message });
    }
  });
  r.get("/api/logs/stream", (c) => streamLogs(c.req, c.res));

  r.get("/api/search/torrents", async (c) => {
    const q = c.query.get("q") ?? "";
    if (!q.trim()) return c.json(400, { ok: false, message: "q is required" });
    try {
      c.json(200, await searchTorrents(q));
    } catch (err) {
      c.json(500, { ok: false, message: (err as Error).message });
    }
  });

  r.post("/api/actions/:id", async (c) => {
    const id = c.params.id as ActionId;
    if (!ACTION_IDS.includes(id)) return c.json(404, { ok: false, message: "Unknown action" });
    try {
      logger.info("Dashboard action requested", { action: id, client: requestClient(c.req) });
      c.json(200, await runAction(id));
    } catch (err) {
      c.json(409, { ok: false, message: (err as Error).message });
    }
  });

  // Bulk destructive work is the highest-consequence thing the dashboard can do,
  // so record the caller and the full target list before acting.
  r.post("/api/episodes/bulk/:action", async (c) => {
    const action = c.params.action as BulkEpisodeActionId;
    if (!BULK_EPISODE_ACTIONS.includes(action)) {
      return c.json(404, { ok: false, message: "Unknown bulk episode action" });
    }
    const body = await c.body();
    const crc32s = Array.isArray(body?.crc32s) ? (body.crc32s as string[]) : [];
    const deleteFile = Boolean(body?.deleteFile);
    try {
      logger.info("Bulk episode action requested", {
        action,
        count: crc32s.length,
        deleteFile,
        client: requestClient(c.req),
        crc32s: crc32s.slice(0, 200),
      });
      const result = await runBulkEpisodeAction(action, crc32s, { deleteFile });
      c.json(result.ok ? 200 : 409, result);
    } catch (err) {
      c.json(409, { ok: false, message: (err as Error).message });
    }
  });

  // Fetches episodes that have no pipeline row at all. `upgrade` is the only
  // action that can start a download without an existing record, so it doubles as
  // "download these missing episodes".
  r.post("/api/episodes/download-missing", async (c) => {
    const body = await c.body();
    const crc32s = Array.isArray(body?.crc32s) ? (body.crc32s as string[]) : [];
    try {
      logger.info("Download-missing requested", {
        count: crc32s.length,
        client: requestClient(c.req),
        crc32s: crc32s.slice(0, 200),
      });
      const result = await runBulkEpisodeAction("upgrade", crc32s);
      c.json(result.ok ? 200 : 409, result);
    } catch (err) {
      c.json(409, { ok: false, message: (err as Error).message });
    }
  });

  r.post("/api/episodes/:crc32/:action", async (c) => {
    const action = c.params.action as EpisodeActionId;
    if (!EPISODE_ACTIONS.includes(action)) return c.json(404, { ok: false, message: "Unknown episode action" });
    const body = (action === "remove" || action === "download-source") ? await c.body() : {};
    try {
      if (action === "remove") {
        logger.info("Episode remove requested", {
          crc32: c.params.crc32.toUpperCase(),
          deleteFile: Boolean(body?.deleteFile),
          client: requestClient(c.req),
        });
      }
      const result = await runEpisodeAction(action, c.params.crc32.toUpperCase(), {
        deleteFile: Boolean(body?.deleteFile),
        source: typeof body?.source === "string" ? body.source : undefined,
        title: typeof body?.title === "string" ? body.title : undefined,
      });
      c.json(result.ok ? 200 : 409, result);
    } catch (err) {
      c.json(409, { ok: false, message: (err as Error).message });
    }
  });

  r.get("/api/downloads/progress", async (c) => {
    const downloading = getEpisodesByStatus("downloading");
    if (downloading.length === 0) { c.json(200, {}); return; }
    const hashes = downloading.flatMap(ep => ep.torrent_hash ? [ep.torrent_hash] : []);
    try {
      const torrents = await getQbitClient().getTorrents(hashes);
      const hashToCrc32 = Object.fromEntries(
        downloading.map(ep => [ep.torrent_hash?.toLowerCase(), ep.crc32])
      );
      const result: Record<string, object> = {};
      for (const t of torrents) {
        const crc32 = hashToCrc32[t.hash.toLowerCase()];
        if (crc32) result[crc32] = { progress: t.progress, dlspeed: t.dlspeed, eta: t.eta, state: t.state, size: t.size };
      }
      c.json(200, result);
    } catch (err) {
      c.json(500, { ok: false, message: (err as Error).message });
    }
  });

  r.get("/api/metadata/:crc32", async (c) => {
    try {
      const crc32 = c.params.crc32.toUpperCase();
      const dbEp = getEpisodeByCrc32(crc32);
      const resolved = await resolveEpisodeByCrc32(crc32);
      c.json(200, { ...resolved, resolution: dbEp?.resolution ?? null });
    } catch (err) {
      c.json(404, { ok: false, message: (err as Error).message });
    }
  });

  // Files on disk whose name doesn't match our canonical scheme, and a bulk
  // rename for the selected ones.
  r.get("/api/naming/candidates", async (c) => {
    try {
      c.json(200, await scanNamingCandidates());
    } catch (err) {
      c.json(500, { ok: false, message: (err as Error).message });
    }
  });
  r.post("/api/naming/normalize", async (c) => {
    const body = await c.body();
    const crc32s = Array.isArray(body?.crc32s) ? (body.crc32s as string[]) : [];
    try {
      c.json(200, await runNormalizeNaming(crc32s));
    } catch (err) {
      c.json(409, { ok: false, message: (err as Error).message });
    }
  });

  // GET returns the last poller snapshot; POST forces an immediate re-check.
  r.get("/api/health/full", (c) => c.json(200, getStoredHealth()));
  r.post("/api/health/check", async (c) => {
    try {
      c.json(200, await runHealthCheck());
    } catch (err) {
      c.json(500, { ok: false, message: (err as Error).message });
    }
  });

  r.get("/api/auth", (c) => c.json(200, getAuthState()));
  r.post("/api/auth/password", async (c) => {
    const body = await c.body();
    const password = typeof body?.password === "string" ? body.password : "";
    if (password.length < 6) return c.json(400, { ok: false, message: "Password must be at least 6 characters" });
    setPassword(password);
    c.json(200, { ok: true, message: "Password updated" });
  });
  r.post("/api/auth/toggle", async (c) => {
    const body = await c.body();
    const result = setAuthEnabled(Boolean(body?.enabled));
    c.json(result.ok ? 200 : 400, result);
  });

  r.get("/api/settings", (c) => c.json(200, describeSettings()));
  r.get("/api/poster-sets", (c) =>
    c.json(200, describePosterSets(getSettingValue("POSTER_REPO_RAW_BASE")))
  );
  r.post("/api/settings", async (c) => {
    const body = await c.body();
    if (!body || typeof body.key !== "string") return c.json(400, { ok: false, message: "Missing key" });
    const result = applySetting(body.key, String(body.value ?? ""));
    c.json(result.ok ? 200 : 400, result);
  });
  r.post("/api/settings/reset", async (c) => {
    const body = await c.body();
    if (!body || typeof body.key !== "string") return c.json(400, { ok: false, message: "Missing key" });
    c.json(200, resetSetting(body.key));
  });

  // Sends a test embed to the configured Discord webhook so users can verify it.
  r.post("/api/discord/test", async (c) => {
    const result = await sendDiscordTest();
    c.json(result.ok ? 200 : 400, result);
  });

  return r;
}

export function startDashboard(): http.Server {
  const cfg = getConfig();
  const router = buildRouter();

  if (!isAuthEnabled()) {
    logger.warn("Dashboard is UNAUTHENTICATED — set a password in the dashboard (Auth section) to secure it");
  }

  const server = http.createServer(async (req, res) => {
    try {
      const reqPath = (req.url ?? "/").split("?")[0];

      // Health check — unauthenticated, so Docker HEALTHCHECK works regardless of auth.
      if (reqPath === "/api/health") {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, version, uptimeSec: Math.floor(process.uptime()) }));
        return;
      }

      if (!checkRequestAuth(req)) {
        res.writeHead(401, { "WWW-Authenticate": 'Basic realm="One Pace Automator", charset="UTF-8"' });
        res.end("Authentication required");
        return;
      }

      if (await router.handle(req, res)) return;

      // Unmatched /api/* is a 404; everything else falls through to static files.
      if (reqPath.startsWith("/api/")) {
        res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, message: "Not found" }));
        return;
      }
      if ((req.method ?? "GET") === "GET") {
        return serveStatic(res, reqPath);
      }
      res.writeHead(405).end("Method not allowed");
    } catch (err) {
      logger.error("Dashboard request error", { error: (err as Error).message });
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, message: "Internal error" }));
      }
    }
  });

  server.listen(cfg.DASHBOARD_PORT, () => {
    logger.info("Dashboard listening", { port: cfg.DASHBOARD_PORT });
  });
  return server;
}
