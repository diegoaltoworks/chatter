import type { ChannelSenderRegistry } from "../channels/senders";
import { createConsoleLogger, type Logger } from "../core/logger";
import { composeMessage } from "./compose";
import { deliver } from "./deliver";
import { dueDrops, staleDrops } from "./dueDrops";
import type { ComposeFn, ScheduleClaimStore, ScheduleEntry, TickResult } from "./types";

export interface TickOptions {
  claims: ScheduleClaimStore;
  senders: ChannelSenderRegistry;
  now: number;
  graceMs: number;
  fallbackMessage: string;
  compose?: ComposeFn;
  voiceAttempted?: boolean;
  logger?: Logger;
}

/**
 * One scheduler tick over caller-supplied candidate entries. Chatter stores
 * no schedule content of its own — `entries` is whatever the caller's own
 * store considers pending; this adds the exactly-once claim, the grace
 * window, and delivery on top.
 */
export async function runTick(entries: ScheduleEntry[], options: TickOptions): Promise<TickResult> {
  const logger = options.logger ?? createConsoleLogger();
  const result: TickResult = { sent: [], notClaimed: [], stale: [], failed: [] };

  for (const entry of staleDrops(entries, options.now, options.graceMs)) {
    result.stale.push(entry.id);
  }

  for (const entry of dueDrops(entries, options.now, options.graceMs)) {
    const claimed = await options.claims.claim(entry.id, options.now);
    if (!claimed) {
      result.notClaimed.push(entry.id);
      continue;
    }

    try {
      const message = await composeMessage(entry, options.compose, options.fallbackMessage, logger);
      const delivered = await deliver(entry, message, {
        senders: options.senders,
        voiceAttempted: options.voiceAttempted,
      });

      if (delivered) {
        result.sent.push(entry.id);
      } else {
        await options.claims.release(entry.id);
        result.failed.push(entry.id);
      }
    } catch (error) {
      // A caller-supplied sender registry is not guaranteed to degrade to
      // false like the built-in one — an unexpected throw must still free
      // the claim rather than block the entry until claimTimeoutMs.
      logger.warn(`Scheduler delivery failed for entry "${entry.id}":`, error);
      await options.claims.release(entry.id);
      result.failed.push(entry.id);
    }
  }

  return result;
}
