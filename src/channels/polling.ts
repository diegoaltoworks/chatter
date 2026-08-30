/**
 * Shared config surface for a long-poll style channel (Telegram, Matrix): the
 * gates/persona/history/rate-limit knobs `createInboundPipeline` accepts, the
 * brain hooks (via `BrainHooks`), and the sleep/now/logger overrides tests
 * use. Each transport extends this with its own protocol specifics (poll
 * timeout vs. sync timeout, bot token vs. homeserver credentials, ...): see
 * `./telegram/channel.ts` and `./matrix/channel.ts`.
 */

import type { Logger } from "../core/logger";
import type { HistoryCompactionOptions } from "../history/compaction";
import type { HistoryStore } from "../history/types";
import type { BrainHooks } from "../types";
import type { SessionIdentityRegistry } from "./gates";

export interface PollingChannelConfig extends BrainHooks {
  /** Channel and sender-registry name. Override to run more than one bot in one process. */
  name?: string;
  /** Group chats eligible for a reply. Empty (default) = every group/room. Has no effect on DMs, which always reply. */
  allowedChats?: string[];
  model?: string;
  /** Extra system-prompt section describing the delivery channel; passed through to `prepareChat`. */
  channelHint?: string;
  /** A throw/rejection is treated as "no persona" for that turn. */
  personaResolver?: (ctx: {
    sender: string;
    text: string;
  }) => string | undefined | Promise<string | undefined>;
  /** Off by default — the channel stays single-turn until a store is configured. */
  history?: {
    store: HistoryStore;
    /** Most recent turns to load per reply. @default 20 */
    limit?: number;
    /**
     * Excludes a sender from history entirely — see
     * `InboundPipelineConfig.history.historyEnabledFor` in `./channels`.
     * @default every sender is enabled
     */
    historyEnabledFor?: (sender: string) => boolean | Promise<boolean>;
    /**
     * Summarize-then-truncate compaction — see
     * `InboundPipelineConfig.history.compaction` in `./channels`.
     * @default off
     */
    compaction?: HistoryCompactionOptions;
  };
  muteRegex?: RegExp;
  unmuteRegex?: RegExp;
  /** Neutral, overridable acknowledgements — this module ships no bot personality; unset = silent mute/unmute. */
  muteReply?: string;
  unmuteReply?: string;
  dmRateLimit?: { max: number; windowMs: number };
  groupRateLimit?: { max: number; windowMs: number };
  /**
   * Every identity this process answers to, keyed by endpoint - what `fromBot`
   * is resolved against, so one of your own bots is never answered as a
   * stranger. @default `deps.identities`, the one registry `createServer`
   * owns and shares with every channel; set this only to scope a channel to a
   * registry of your own.
   */
  identities?: SessionIdentityRegistry;
  /** Overridable for tests and for hosts routing through a proxy; defaults to `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** Overridable for tests; defaults to a `setTimeout`-based sleep. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Logger for poll/gate diagnostics. Falls back to the host's `deps.logger`, then a console logger. */
  logger?: Logger;
}

/** `setTimeout`-based sleep, `unref`'d where supported so a pending sleep never keeps the process alive on its own. */
export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer === "object" && "unref" in timer) timer.unref();
  });
}
