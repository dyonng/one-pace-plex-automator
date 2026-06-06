import pino from "pino";
import { EventEmitter } from "events";

const _logger = pino({ level: process.env.LOG_LEVEL ?? "info" });

type Meta = Record<string, unknown>;
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  ts: number;
  level: LogLevel;
  msg: string;
  meta?: Meta;
}

// Every log line is emitted here so the dashboard can persist + live-stream it,
// independent of pino's stdout output. Subscribers attach after boot.
export const logBus = new EventEmitter();
logBus.setMaxListeners(50);

// Mirror pino's level filtering so the dashboard/DB don't capture lines below the
// configured LOG_LEVEL (e.g. debug spam when running at info).
const LEVEL_VALUE: Record<string, number> = {
  trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60, silent: 100,
};
const THRESHOLD = LEVEL_VALUE[process.env.LOG_LEVEL ?? "info"] ?? 30;

function emit(level: LogLevel, msg: string, meta?: Meta): void {
  if (LEVEL_VALUE[level] < THRESHOLD) return;
  logBus.emit("log", { ts: Date.now(), level, msg, meta } as LogEntry);
}

export const logger = {
  debug: (msg: string, meta?: Meta) => { meta ? _logger.debug(meta, msg) : _logger.debug(msg); emit("debug", msg, meta); },
  info:  (msg: string, meta?: Meta) => { meta ? _logger.info(meta, msg)  : _logger.info(msg);  emit("info", msg, meta); },
  warn:  (msg: string, meta?: Meta) => { meta ? _logger.warn(meta, msg)  : _logger.warn(msg);  emit("warn", msg, meta); },
  error: (msg: string, meta?: Meta) => { meta ? _logger.error(meta, msg) : _logger.error(msg); emit("error", msg, meta); },
};
