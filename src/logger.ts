import { getConfig } from "./config";

type Level = "debug" | "info" | "warn" | "error";
const LEVELS: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function log(level: Level, message: string, meta?: Record<string, unknown>) {
  try {
    const minLevel = LEVELS[getConfig().LOG_LEVEL];
    if (LEVELS[level] < minLevel) return;
  } catch {
    // config not ready yet, always log
  }

  const ts = new Date().toISOString();
  const base = `[${ts}] [${level.toUpperCase()}] ${message}`;
  const output = meta ? `${base} ${JSON.stringify(meta)}` : base;

  if (level === "error" || level === "warn") {
    console.error(output);
  } else {
    console.log(output);
  }
}

export const logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => log("debug", msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => log("info", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => log("warn", msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => log("error", msg, meta),
};
