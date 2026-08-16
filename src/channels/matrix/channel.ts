/**
 * Matrix client-server transport: a {@link Channel} that long-polls
 * `/sync`, maps each room event into a `ChannelMessage`, and answers
 * through the shared `createInboundPipeline` — the same gates, persona,
 * buckets, history and `answerFn` seams every other channel uses.
 *
 * Deliberately the plain client-server HTTP API over `fetch`, not an SDK:
 * no optional peer dependency, same as `../telegram`. That also means
 * **no end-to-end encryption support** — an encrypted room's events arrive
 * as opaque `m.room.encrypted` ciphertext this channel cannot decrypt, so
 * it silently cannot see anything sent there. Use this channel only in
 * unencrypted rooms; see docs/matrix.md for the full explanation and why
 * that rules out most default-E2EE personal homeservers for DMs.
 */

import type { AnswerFn, TransformReply } from "../../core/answer";
import type { BucketsFor } from "../../core/buckets";
import { createConsoleLogger, type Logger } from "../../core/logger";
import type { RerankContext, RewriteQuery } from "../../core/pipeline";
import type { HistoryCompactionOptions } from "../../history/compaction";
import type { HistoryStore } from "../../history/types";
import type { Channel } from "../index";
import { createInboundPipeline } from "../pipeline";
import { createMatrixApi, type MatrixApi } from "./api";
import { createMatrixSender, createMatrixSyncHandler } from "./handler";
import { runMatrixSyncLoop } from "./sync";
import { directRoomIds } from "./updates";

/** Long-poll hold time. The homeserver holds the request open this long when nothing new happened, so a sync is one request per 30s idle — not a busy loop. */
const DEFAULT_SYNC_TIMEOUT_MS = 30_000;

export interface MatrixChannelConfig {
  /** Homeserver client-server API origin, e.g. `https://matrix.example.org`. */
  homeserverUrl: string;
  /** A logged-in bot user's access token. A credential — pass it from the environment, never commit it. */
  accessToken: string;
  /** Channel and sender-registry name. Override to run more than one bot in one process. @default "matrix" */
  name?: string;
  /** Group rooms eligible for a reply. Empty (default) = every room. Has no effect on DMs, which always reply. */
  allowedChats?: string[];
  answerFn?: AnswerFn;
  bucketsFor?: BucketsFor;
  /** Rewrites the retrieval query before it reaches the vector store — see `ChatterConfig.rewriteQuery`. Falls back to the server's own. */
  rewriteQuery?: RewriteQuery;
  /** Post-processes retrieved chunks before they're folded into the prompt — see `ChatterConfig.rerankContext`. Falls back to the server's own. */
  rerankContext?: RerankContext;
  /** Modifies or vetoes the produced reply before delivery — see `ChatterConfig.transformReply`. Falls back to the server's own. */
  transformReply?: TransformReply;
  model?: string;
  /** Extra system-prompt section describing the delivery channel; passed through to `prepareChat`. @default "Channel: Matrix." */
  channelHint?: string;
  /** A throw/rejection is treated as "no persona" for that turn. `sender` is the namespaced `mx:<user id>` key. */
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
  /** Auto-accept room invites, so the bot can actually receive messages in a room a user just invited it to. @default true */
  autoJoin?: boolean;
  /** @default 30000 */
  syncTimeoutMs?: number;
  /** Resume point for `/sync`. Omitted = an initial full sync (see docs/matrix.md on `since`-token persistence). */
  initialSince?: string;
  /** Called with each acknowledged `since` token, for a host that wants to persist it across restarts. */
  onSince?: (since: string) => void;
  /** Overridable for tests and for hosts routing through a proxy; defaults to `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** Overridable for tests, which fake the client-server API instead of calling it; defaults to a `fetch` client over {@link MatrixChannelConfig.homeserverUrl}/{@link MatrixChannelConfig.accessToken}. */
  api?: MatrixApi;
  /** Overridable for tests; defaults to a `setTimeout`-based sleep. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Logger for sync/gate diagnostics. Falls back to the host's `deps.logger`, then a console logger. */
  logger?: Logger;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer === "object" && "unref" in timer) timer.unref();
  });
}

export function createMatrixChannel(config: MatrixChannelConfig): Channel {
  const channelName = config.name ?? "matrix";
  const allowedChats = config.allowedChats ?? [];
  const sleep = config.sleep ?? defaultSleep;
  const syncTimeoutMs = config.syncTimeoutMs ?? DEFAULT_SYNC_TIMEOUT_MS;

  let stopped = false;
  let registered = false;
  let senders: { unregister(name: string): void } | undefined;
  // This session's own sent event ids — shared between the sync handler
  // (reply-to-bot detection) and the registered sender (a scheduler/flow
  // reply outside a pipeline turn is still recognised later).
  const sentEventIds = new Set<string>();

  return {
    name: channelName,
    async start(deps) {
      const log = config.logger ?? deps.logger ?? createConsoleLogger();
      const api =
        config.api ??
        createMatrixApi({
          homeserverUrl: config.homeserverUrl,
          accessToken: config.accessToken,
          fetch: config.fetch,
        });

      // Resolved eagerly, before returning: the bot's own user id is what
      // mention, loop-guard and reply-to detection compare against, so a
      // channel that synced without it would misfire on all three. A bad
      // token fails THIS start() call, which `createServer` logs and
      // isolates, instead of failing silently later inside the sync loop.
      const me = await api.whoami();
      const label = `Matrix[${me.userId}]`;

      // Seeds direct-message detection from the account state as it stands
      // right now, rather than waiting for `m.direct` to show up in a future
      // `/sync` response — an incremental sync (resuming from
      // `initialSince`) only repeats an account-data event when it actually
      // changes, so without this every already-known DM would need a fresh
      // `m.direct` write before this process would recognise it again.
      // Best-effort: a fetch failure just means DM detection lags until the
      // next `m.direct` change reaches `/sync`, not a broken start().
      let initialDirectRooms: Set<string> | undefined;
      try {
        const direct = await api.getAccountData<Record<string, unknown>>(me.userId, "m.direct");
        if (direct) initialDirectRooms = directRoomIds([{ type: "m.direct", content: direct }]);
      } catch (error) {
        log.warn(`${label}: could not load m.direct account data at start:`, error);
      }

      deps.senders.register(channelName, createMatrixSender(api, sentEventIds));
      senders = deps.senders;
      registered = true;

      // Built once per start, not per batch: gates, mute state and rate
      // limiters live in this closure.
      const pipeline = createInboundPipeline(
        { client: deps.client, store: deps.store, prompts: deps.prompts },
        {
          channel: channelName,
          answerFn: config.answerFn ?? deps.config.answerFn,
          bucketsFor: config.bucketsFor ?? deps.config.bucketsFor,
          rewriteQuery: config.rewriteQuery ?? deps.config.rewriteQuery,
          rerankContext: config.rerankContext ?? deps.config.rerankContext,
          transformReply: config.transformReply ?? deps.config.transformReply,
          model: config.model,
          channelHint: config.channelHint ?? "Channel: Matrix.",
          personaResolver: config.personaResolver,
          history: config.history,
          allowedChats,
          muteRegex: config.muteRegex,
          unmuteRegex: config.unmuteRegex,
          muteReply: config.muteReply,
          unmuteReply: config.unmuteReply,
          dmRateLimit: config.dmRateLimit,
          groupRateLimit: config.groupRateLimit,
          now: config.now,
          logger: log,
        },
      );

      const handleSync = createMatrixSyncHandler({
        api,
        me,
        pipeline,
        allowedChats,
        sentEventIds,
        autoJoin: config.autoJoin,
        initialDirectRooms,
        logger: log,
        label,
      });

      // Not awaited: `start` must return once the transport is initiated,
      // not once syncing ends (which is at shutdown). Unlike the Telegram
      // long poll, there is no AbortController here — `/sync` has no
      // in-flight request to cut short quickly: `stop()` just flips
      // `stopped`, and the current sync call (already waiting on the
      // homeserver) is left to return on its own timeout, same as a sync
      // that happened to be idle when shutdown began.
      void runMatrixSyncLoop({
        sync: (since) => api.sync({ since, timeoutMs: syncTimeoutMs }),
        handleSync,
        isStopped: () => stopped,
        sleep,
        initialSince: config.initialSince,
        onSince: config.onSince,
        logger: log,
        label,
      }).catch((error) => log.error(`${label}: sync loop ended unexpectedly:`, error));

      log.info(`${label}: syncing for events`);
    },
    stop() {
      stopped = true;
      if (registered) {
        senders?.unregister(channelName);
        registered = false;
      }
    },
  };
}
