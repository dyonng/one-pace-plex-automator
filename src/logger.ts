import pino from "pino";

const _logger = pino({ level: process.env.LOG_LEVEL ?? "info" });

type Meta = Record<string, unknown>;

export const logger = {
  debug: (msg: string, meta?: Meta) => meta ? _logger.debug(meta, msg) : _logger.debug(msg),
  info:  (msg: string, meta?: Meta) => meta ? _logger.info(meta, msg)  : _logger.info(msg),
  warn:  (msg: string, meta?: Meta) => meta ? _logger.warn(meta, msg)  : _logger.warn(msg),
  error: (msg: string, meta?: Meta) => meta ? _logger.error(meta, msg) : _logger.error(msg),
};
