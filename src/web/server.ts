import http from "http";
import fs from "fs";
import path from "path";
import { getConfig } from "../config";
import { logger, logBus, LogEntry } from "../logger";
import { getRecentLogs, listEpisodes, countByStatus } from "../db";
import { getData } from "../metadata";
import { resolvePlexConnection } from "../plex";
import { runtime, isBusy, busyLabel, runAction, ActionId } from "../controls";
import { buildAuth, type Verifier } from "./auth";
import { version } from "../../package.json";

const PUBLIC_DIR = path.join(__dirname, "..", "..", "public");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".ico": "image/x-icon",
};

function authorized(req: http.IncomingMessage, verify: Verifier): boolean {
  const header = req.headers.authorization ?? "";
  if (!header.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const pass = decoded.slice(decoded.indexOf(":") + 1);
  return verify(pass);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(json);
}

function serveStatic(res: http.ServerResponse, file: string): void {
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
    schedule: { pollCron: cfg.POLL_CRON, downloadCheck: "30s" },
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

  const onLog = (entry: LogEntry) => {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  };
  logBus.on("log", onLog);

  const heartbeat = setInterval(() => res.write(": ping\n\n"), 25_000);

  const cleanup = () => {
    clearInterval(heartbeat);
    logBus.off("log", onLog);
  };
  req.on("close", cleanup);
  res.on("error", cleanup);
}

async function readActionId(req: http.IncomingMessage): Promise<ActionId | null> {
  // Action id comes from the URL path: /api/actions/<id>
  const url = req.url ?? "";
  const id = url.split("/").pop()?.split("?")[0] ?? "";
  const valid: ActionId[] = ["poll", "sync", "refresh-metadata", "retry-failed"];
  return valid.includes(id as ActionId) ? (id as ActionId) : null;
}

export function startDashboard(): http.Server | null {
  const cfg = getConfig();
  const verify = buildAuth();

  if (!verify) {
    logger.warn("Dashboard disabled — set DASHBOARD_TOKEN_HASH (or DASHBOARD_TOKEN) to enable it");
    return null;
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = req.url ?? "/";
      const method = req.method ?? "GET";

      if (!authorized(req, verify)) {
        res.writeHead(401, {
          "WWW-Authenticate": 'Basic realm="One Pace Automator", charset="UTF-8"',
        });
        res.end("Authentication required");
        return;
      }

      // API routes
      if (url.startsWith("/api/")) {
        if (method === "GET" && url.startsWith("/api/status")) {
          return sendJson(res, 200, await buildStatus());
        }
        if (method === "GET" && url.startsWith("/api/logs/stream")) {
          return streamLogs(req, res);
        }
        if (method === "GET" && url.startsWith("/api/logs")) {
          return sendJson(res, 200, getRecentLogs(500));
        }
        if (method === "POST" && url.startsWith("/api/actions/")) {
          const id = await readActionId(req);
          if (!id) return sendJson(res, 404, { ok: false, message: "Unknown action" });
          try {
            const result = await runAction(id);
            return sendJson(res, 200, result);
          } catch (err) {
            return sendJson(res, 409, { ok: false, message: (err as Error).message });
          }
        }
        return sendJson(res, 404, { ok: false, message: "Not found" });
      }

      // Static files
      if (method === "GET") {
        const file = url === "/" ? "index.html" : url.replace(/^\//, "").split("?")[0];
        return serveStatic(res, file);
      }

      res.writeHead(405).end("Method not allowed");
    } catch (err) {
      logger.error("Dashboard request error", { error: (err as Error).message });
      if (!res.headersSent) sendJson(res, 500, { ok: false, message: "Internal error" });
    }
  });

  server.listen(cfg.DASHBOARD_PORT, () => {
    logger.info("Dashboard listening", { port: cfg.DASHBOARD_PORT });
  });
  return server;
}
