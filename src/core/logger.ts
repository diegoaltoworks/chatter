/**
 * Leveled logging seam. The default implementation never writes to stdout —
 * only stderr — so a host running the stdio MCP transport (which reserves
 * stdout for the JSON-RPC stream) gets a clean channel by default, and so do
 * hosts that simply want their own program output on stdout to stay
 * unpolluted by library logging.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/**
 * Console-backed logger. Every level writes via `console.error` (stderr),
 * gated by `level` (default `"info"`, so `debug` is silent unless a caller
 * opts in) — see the module docstring for why stdout is never touched.
 */
export function createConsoleLogger(level: LogLevel = "info"): Logger {
  const threshold = LEVEL_ORDER[level];
  const write =
    (at: LogLevel) =>
    (...args: unknown[]) => {
      if (LEVEL_ORDER[at] < threshold) return;
      console.error(`[${at}]`, ...args);
    };
  return {
    debug: write("debug"),
    info: write("info"),
    warn: write("warn"),
    error: write("error"),
  };
}

/** Resolves a caller-supplied logger, falling back to the default console logger. */
export function resolveLogger(logger?: Logger, level?: LogLevel): Logger {
  return logger ?? createConsoleLogger(level);
}
