/**
 * Structured logger — JSON in pipes, human-readable in TTY.
 *
 * Usage:
 *   const log = createLogger({ context: { phase: "cli" } });
 *   log.info("starting...");
 *   const child = log.child({ unit: "auth" });
 */

import { appendFileSync } from "node:fs";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  child(context: Record<string, unknown>): Logger;
}

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const TTY_PREFIX: Record<LogLevel, string> = {
  debug: "\x1b[90m[DBG]\x1b[0m",
  info: "",
  warn: "\x1b[33m[WRN]\x1b[0m",
  error: "\x1b[31m[ERR]\x1b[0m",
};

function formatMsg(msg: string, args: unknown[]): string {
  if (args.length === 0) return msg;
  return [msg, ...args.map(String)].join(" ");
}

export function createLogger(opts: {
  context?: Record<string, unknown>;
  level?: LogLevel;
  logFile?: string;
}): Logger {
  const context = opts.context ?? {};
  const minLevel = opts.level ?? "info";
  const logFile = opts.logFile ?? process.env.SUPER_RALPH_LOG_FILE;

  function emit(level: LogLevel, msg: string, args: unknown[]): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[minLevel]) return;

    const fullMsg = formatMsg(msg, args);
    const isStderr = level === "warn" || level === "error";
    const stream = isStderr ? process.stderr : process.stdout;
    const isTTY = process.stdout.isTTY;

    if (isTTY) {
      const prefix = TTY_PREFIX[level];
      const line = prefix ? `${prefix} ${fullMsg}\n` : `${fullMsg}\n`;
      stream.write(line);
    } else {
      const record = { ts: new Date().toISOString(), level, msg: fullMsg, ...context };
      stream.write(JSON.stringify(record) + "\n");
    }

    if (logFile) {
      const record = { ts: new Date().toISOString(), level, msg: fullMsg, ...context };
      appendFileSync(logFile, JSON.stringify(record) + "\n");
    }
  }

  return {
    debug: (msg, ...args) => emit("debug", msg, args),
    info: (msg, ...args) => emit("info", msg, args),
    warn: (msg, ...args) => emit("warn", msg, args),
    error: (msg, ...args) => emit("error", msg, args),
    child(childContext) {
      return createLogger({
        context: { ...context, ...childContext },
        level: minLevel,
        logFile,
      });
    },
  };
}
