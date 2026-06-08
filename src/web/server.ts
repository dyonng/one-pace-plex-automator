import http from "http";
import fs from "fs";
import path from "path";
import { getConfig } from "../config";
import { logger, logBus, LogEntry } from "../logger";
import { getRecentLogs, listEpisodes, countByStatus } from "../db";
import { getData } from "../metadata";
import { resolvePlexConnection } from "../plex";
import { runtime, isBusy, busyLabel, runAction, runEpisodeAction, ActionId, EpisodeActionId } from "../controls";
import { describeSettings, applySetting, resetSetting, getSettingValue } from "../settings";
import { sendDiscordTest } from "../discord";
import { scanCoverage, getStoredCoverage } from "../coverage";
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
  "poll",
  "sync",
  "refresh-metadata",
  "retry-failed",
  "sync-posters",
  "force-posters",
];
const EPISODE_ACTIONS: EpisodeActionId[] = ["download", "retry", "resync", "remove"];

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
    episodes: listEpisodes(),
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

function buildRouter(): Router {
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
  r.get("/api/logs/stream", (c) => streamLogs(c.req, c.res));

  r.post("/api/actions/:id", async (c) => {
    const id = c.params.id as ActionId;
    if (!ACTION_IDS.includes(id)) return c.json(404, { ok: false, message: "Unknown action" });
    try {
      c.json(200, await runAction(id));
    } catch (err) {
      c.json(409, { ok: false, message: (err as Error).message });
    }
  });

  r.post("/api/episodes/:crc32/:action", async (c) => {
    const action = c.params.action as EpisodeActionId;
    if (!EPISODE_ACTIONS.includes(action)) return c.json(404, { ok: false, message: "Unknown episode action" });
    const body = action === "remove" ? await c.body() : {};
    try {
      const result = await runEpisodeAction(action, c.params.crc32.toUpperCase(), {
        deleteFile: Boolean(body?.deleteFile),
      });
      c.json(result.ok ? 200 : 409, result);
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
