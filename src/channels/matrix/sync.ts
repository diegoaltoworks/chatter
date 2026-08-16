/**
 * The `/sync` long-poll loop, isolated from both the HTTP client and the
 * channel so its failure behaviour is testable without either — the same
 * shape as `../telegram/poll.ts`'s `runLongPoll`, adapted to Matrix's
 * `since`-token pagination instead of an acknowledged offset.
 *
 * The property that matters: a homeserver that is down, rate-limiting, or
 * rejecting the token must never turn into a tight retry loop. Every
 * failure backs off exponentially, and `M_LIMIT_EXCEEDED`'s own
 * `retry_after_ms` wins over that backoff when the homeserver sends one.
 */

import { createConsoleLogger, type Logger } from "../../core/logger";
import { exponentialBackoffMs } from "../backoff";
import { MatrixApiError, type MatrixSyncResponse } from "./api";

const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 60_000;

/** Exponential backoff: 2s, 4s, 8s ... capped at a minute. `failures` is the count including the one just seen. */
export function syncBackoffMs(failures: number): number {
  return exponentialBackoffMs(BASE_DELAY_MS, MAX_DELAY_MS, failures);
}

/**
 * How long to wait after a failed sync. `M_LIMIT_EXCEEDED`'s
 * `retry_after_ms` is an instruction, not a hint — honour it verbatim even
 * when it exceeds the backoff cap, because syncing again sooner just
 * extends the rate-limit window.
 */
export function retryDelayMs(error: unknown, failures: number): number {
  const retryAfterMs = error instanceof MatrixApiError ? error.retryAfterMs : undefined;
  return retryAfterMs ?? syncBackoffMs(failures);
}

export interface MatrixSyncLoopDeps {
  /** One `/sync` call. Rejections are backed off; they never end the loop. */
  sync(since: string | undefined): Promise<MatrixSyncResponse>;
  /** Per-batch work. A throw is logged and skipped — one bad batch never stops the loop. */
  handleSync(response: MatrixSyncResponse): Promise<void>;
  /** Checked before every sync, and again after a failure, so `stop()` cuts the loop instead of sleeping out a backoff first. */
  isStopped(): boolean;
  /** Overridable for tests; a real channel passes a `setTimeout`-based sleep. */
  sleep(ms: number): Promise<void>;
  /** Where this loop's `since` token resumes from. Omitted = an initial full sync. */
  initialSince?: string;
  /** Called with each newly acknowledged `since` token, for a host that persists it. */
  onSince?(since: string): void;
  logger?: Logger;
  /** Prefix for log lines, e.g. `Matrix[@bot:example.org]`. */
  label?: string;
}

/**
 * Syncs until `isStopped()`, resolving with the last `since` token reached
 * (what a restart would resume from).
 *
 * The token advances BEFORE the batch is handled, matching the Telegram
 * poll loop's offset-first ordering: a handler that throws on one bad
 * batch must not make the homeserver redeliver it forever, which would
 * wedge the loop on a single poison event and starve every later one. It
 * advances only for a batch this loop is actually going to handle, though:
 * a stop that lands between the sync and the handler leaves the token where
 * it was, so a restart resumes at the unhandled batch rather than past it.
 */
export async function runMatrixSyncLoop(deps: MatrixSyncLoopDeps): Promise<string | undefined> {
  const logger = deps.logger ?? createConsoleLogger();
  const label = deps.label ?? "Matrix";
  let since = deps.initialSince;
  let failures = 0;

  while (!deps.isStopped()) {
    let response: MatrixSyncResponse;
    try {
      response = await deps.sync(since);
    } catch (error) {
      // An abort fired by stop() surfaces here as a rejection; it is a
      // shutdown, not a fault, and must not be logged or backed off.
      if (deps.isStopped()) break;
      failures += 1;
      const delay = retryDelayMs(error, failures);
      logger.warn(`${label}: sync failed, retrying in ${Math.round(delay / 1000)}s:`, error);
      await deps.sleep(delay);
      continue;
    }

    failures = 0;
    // Before the token moves: a batch this loop is not going to handle must
    // stay unacknowledged, or a host persisting `onSince` would resume after
    // messages nobody ever answered.
    if (deps.isStopped()) break;
    since = response.next_batch;
    deps.onSince?.(since);
    try {
      await deps.handleSync(response);
    } catch (error) {
      logger.warn(`${label}: batch ending at ${since} handling failed:`, error);
    }
  }

  return since;
}
