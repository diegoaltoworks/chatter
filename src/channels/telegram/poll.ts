/**
 * The getUpdates long-poll loop, isolated from both the HTTP client and the
 * channel so its failure behaviour is testable without either.
 *
 * The property that matters: a Bot API that is down, rate-limiting, or
 * rejecting the token must never turn into a tight retry loop. Every failure
 * backs off exponentially, and Telegram's own `retry_after` wins over that
 * backoff when it sends one.
 */

import { createConsoleLogger, type Logger } from "../../core/logger";
import { TelegramApiError, type TelegramUpdate } from "./api";
import { nextOffset } from "./updates";

const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 60_000;

/** Exponential backoff: 2s, 4s, 8s ... capped at a minute. `failures` is the count including the one just seen. */
export function pollBackoffMs(failures: number): number {
  return Math.min(BASE_DELAY_MS * 2 ** Math.min(failures, 20), MAX_DELAY_MS);
}

/**
 * How long to wait after a failed poll. A `retry_after` from Telegram (HTTP
 * 429 flood control) is an instruction, not a hint — honour it verbatim even
 * when it exceeds the backoff cap, because polling again sooner just extends
 * the flood-wait.
 */
export function retryDelayMs(error: unknown, failures: number): number {
  const retryAfterMs = error instanceof TelegramApiError ? error.retryAfterMs : undefined;
  return retryAfterMs ?? pollBackoffMs(failures);
}

export interface LongPollDeps {
  /** One `getUpdates` call. Rejections are backed off; they never end the loop. */
  getUpdates(offset: number | undefined): Promise<TelegramUpdate[]>;
  /** Per-update work. A throw is logged and skipped — one bad update never stops the loop. */
  handleUpdate(update: TelegramUpdate): Promise<void>;
  /** Checked before every poll, and again after a failure, so `stop()` cuts the loop instead of sleeping out a backoff first. */
  isStopped(): boolean;
  /** Overridable for tests; a real channel passes a `setTimeout`-based sleep. */
  sleep(ms: number): Promise<void>;
  /** Where this loop's offset resumes from. Omitted = whatever Telegram has queued. */
  initialOffset?: number;
  /** Called with each newly acknowledged offset, for a host that persists it. */
  onOffset?(offset: number): void;
  logger?: Logger;
  /** Prefix for log lines, e.g. `Telegram[mybot]`. */
  label?: string;
}

/**
 * Polls until `isStopped()`, resolving with the last offset reached (what a
 * restart would resume from).
 *
 * The offset advances BEFORE the update is handled: a handler that throws on
 * one specific update must not make Telegram redeliver it forever, which would
 * wedge the loop on a single poison message and starve every later one. It
 * advances only for an update this loop is actually going to handle, though:
 * a stop that lands mid-batch leaves the offset where it was, so a restart
 * resumes at the unhandled update rather than past it (matching
 * `../matrix/sync.ts`'s `since`-token ordering).
 */
export async function runLongPoll(deps: LongPollDeps): Promise<number | undefined> {
  const logger = deps.logger ?? createConsoleLogger();
  const label = deps.label ?? "Telegram";
  let offset = deps.initialOffset;
  let failures = 0;

  while (!deps.isStopped()) {
    let updates: TelegramUpdate[];
    try {
      updates = await deps.getUpdates(offset);
    } catch (error) {
      // An abort fired by stop() surfaces here as a rejection; it is a
      // shutdown, not a fault, and must not be logged or backed off.
      if (deps.isStopped()) break;
      failures += 1;
      const delay = retryDelayMs(error, failures);
      logger.warn(`${label}: getUpdates failed, retrying in ${Math.round(delay / 1000)}s:`, error);
      await deps.sleep(delay);
      continue;
    }

    failures = 0;
    for (const update of updates) {
      // Before the offset moves: an update this loop is not going to handle
      // must stay unacknowledged, or a host persisting `onOffset` would
      // resume past a message nobody ever answered, the same ordering
      // `../matrix/sync.ts`'s `since` token uses.
      if (deps.isStopped()) break;
      offset = nextOffset(update);
      deps.onOffset?.(offset);
      try {
        await deps.handleUpdate(update);
      } catch (error) {
        logger.warn(`${label}: update ${update.update_id} handling failed:`, error);
      }
    }
  }

  return offset;
}
