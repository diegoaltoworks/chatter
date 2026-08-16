import type { Client } from "@libsql/client";
import type { ChannelSenderRegistry } from "../channels/senders";
import { createConsoleLogger, type Logger } from "../core/logger";
import {
  createTursoScheduleClaimStore,
  DEFAULT_CLAIM_TABLE,
  DEFAULT_CLAIM_TIMEOUT_MS,
} from "./claimStore";
import { runTick } from "./tick";
import type { ComposeFn, ScheduleClaimStore, ScheduleEntry, TickResult } from "./types";

export const DEFAULT_GRACE_MS = 5 * 60_000;
export const DEFAULT_INTERVAL_MS = 60_000;
export const DEFAULT_FALLBACK_MESSAGE = "You have a scheduled message.";

export interface SchedulerConfig {
  /**
   * The libsql client the default `ScheduleClaimStore` is built against.
   * Ignored when `claimStore` is supplied - the type stays required for now
   * (narrowing it to reflect that is deferred), so a caller that only wants
   * to inject `claimStore` still has to pass a `Client`, even an unused one.
   */
  db: Client;
  senders: ChannelSenderRegistry;
  /** Returns the caller's own pending candidates for this tick — chatter stores no schedule content. */
  fetchPending: () => Promise<ScheduleEntry[]> | ScheduleEntry[];
  /** The exactly-once claim store. Defaults to a Turso-backed store against `db`; inject your own to run the scheduler on a different backend (see docs/patterns/adding-a-store.md). */
  claimStore?: ScheduleClaimStore;
  tableName?: string;
  graceMs?: number;
  intervalMs?: number;
  claimTimeoutMs?: number;
  instanceId?: string;
  compose?: ComposeFn;
  fallbackMessage?: string;
  voiceAttempted?: boolean;
  onTick?: (result: TickResult) => void;
  onError?: (error: unknown) => void;
  /** Injectable for tests; defaults to `setInterval`/`clearInterval`. */
  schedule?: (fn: () => void, ms: number) => { stop: () => void };
  /** Injectable for tests; defaults to `Date.now`. */
  now?: () => number;
  /** Logger for tick/delivery failures. Default: a console logger writing to stderr. */
  logger?: Logger;
}

export interface Scheduler {
  /** Starts ticking on `intervalMs`. No-op if already started. */
  start(): void;
  /** Stops ticking. No-op if not started. */
  stop(): void;
  /** Runs one tick immediately, outside the interval — useful for tests and manual triggers. */
  tickOnce(): Promise<TickResult>;
}

const defaultSchedule: NonNullable<SchedulerConfig["schedule"]> = (fn, ms) => {
  const timer = setInterval(fn, ms);
  if (typeof timer === "object" && "unref" in timer) timer.unref();
  return { stop: () => clearInterval(timer) };
};

/**
 * The ticker: on each interval, pulls pending candidates from the caller,
 * claims each due one exactly once across every running instance, composes
 * and delivers it, and releases the claim on a failed send so it retries
 * within the grace window instead of being lost.
 */
export function createScheduler(config: SchedulerConfig): Scheduler {
  const claims =
    config.claimStore ??
    createTursoScheduleClaimStore(
      config.db,
      config.instanceId ?? crypto.randomUUID(),
      config.tableName ?? DEFAULT_CLAIM_TABLE,
      config.claimTimeoutMs ?? DEFAULT_CLAIM_TIMEOUT_MS,
    );
  const graceMs = config.graceMs ?? DEFAULT_GRACE_MS;
  const fallbackMessage = config.fallbackMessage ?? DEFAULT_FALLBACK_MESSAGE;
  const now = config.now ?? Date.now;
  const schedule = config.schedule ?? defaultSchedule;
  const logger = config.logger ?? createConsoleLogger();

  let running: { stop: () => void } | undefined;
  let ticking = false;

  async function tickOnce(): Promise<TickResult> {
    const entries = await config.fetchPending();
    const result = await runTick(entries, {
      claims,
      senders: config.senders,
      now: now(),
      graceMs,
      fallbackMessage,
      compose: config.compose,
      voiceAttempted: config.voiceAttempted,
      logger,
    });
    config.onTick?.(result);
    return result;
  }

  return {
    start() {
      if (running) return;
      running = schedule(() => {
        // A tick slower than intervalMs must not pile up concurrent runs.
        if (ticking) return;
        ticking = true;
        tickOnce()
          .catch((error) => {
            if (config.onError) config.onError(error);
            else logger.warn("Scheduler tick failed:", error);
          })
          .finally(() => {
            ticking = false;
          });
      }, config.intervalMs ?? DEFAULT_INTERVAL_MS);
    },
    stop() {
      if (!running) return;
      running.stop();
      running = undefined;
    },
    tickOnce,
  };
}
