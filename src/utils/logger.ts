import { config } from '../config/env';

/**
 * Minimal structured logger.
 *
 * Design choices:
 *  - One JSON object per line. Machines (and later the Phase 4 metrics/stream
 *    pipeline) can parse it; humans can still read it.
 *  - Zero dependencies, so it works in any process (main thread OR a
 *    `worker_thread` in Phase 2) without config gymnastics.
 *  - Level filtering is a cheap integer comparison.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** Extra structured fields attached to a log line. */
export type LogMeta = Record<string, unknown>;

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[config.LOG_LEVEL];
}

function write(level: LogLevel, message: string, meta?: LogMeta): void {
  if (!shouldLog(level)) return;

  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...(meta && Object.keys(meta).length > 0 ? { meta } : {}),
  });

  // Route warn/error to stderr so log collectors can separate them.
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  debug: (message: string, meta?: LogMeta): void => write('debug', message, meta),
  info: (message: string, meta?: LogMeta): void => write('info', message, meta),
  warn: (message: string, meta?: LogMeta): void => write('warn', message, meta),
  error: (message: string, meta?: LogMeta): void => write('error', message, meta),
};

export type Logger = typeof logger;
