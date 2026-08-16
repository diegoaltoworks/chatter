/**
 * Telegram Bot API transport: a {@link Channel} that long-polls `getUpdates`,
 * maps each update into a `ChannelMessage`, and answers through the shared
 * `createInboundPipeline` — the same gates, persona, buckets, history and
 * `answerFn` seams every other channel uses.
 *
 * This is the second transport on the channel SPI, and unlike WhatsApp it
 * needs no optional peer dependency, no session persistence, and no deploy
 * lease: the Bot API is JSON over HTTPS and Telegram itself queues updates
 * per bot token. It is deliberately self-contained — `start(deps)` has
 * everything it needs, so there is no `customRoutes` wiring step (contrast
 * `./channels/whatsapp/inbound.ts`, whose transport and interpretation are
 * separate modules).
 *
 * One caveat worth knowing before choosing this over a user-mode client: a bot
 * cannot start a conversation (the user must message it first), and in groups
 * Telegram's privacy mode means it only receives messages that address it —
 * which is the same policy `decideChannelAction` applies anyway.
 */

import type { AnswerFn, TransformReply } from "../../core/answer";
import type { BucketsFor } from "../../core/buckets";
import { createConsoleLogger, type Logger } from "../../core/logger";
import type { RerankContext, RewriteQuery } from "../../core/pipeline";
import type { HistoryStore } from "../../history/types";
import { isBlockedByAllowlist } from "../gates";
import type { Channel } from "../index";
import { createInboundPipeline, type InboundReplySender } from "../pipeline";
import type { ChannelSender } from "../senders";
import { createTelegramApi, type TelegramApi, type TelegramUpdate } from "./api";
import { runLongPoll } from "./poll";
import { type TelegramBotIdentity, telegramSenderKey, toChannelMessage } from "./updates";

/** Long-poll hold time. Telegram holds the request open this long when no update arrives, so a poll is one request per 30s idle — not a busy loop. */
const DEFAULT_POLL_TIMEOUT_SECONDS = 30;

export interface TelegramChannelConfig {
  /** From @BotFather. A credential — pass it from the environment, never commit it. */
  botToken: string;
  /** Channel and sender-registry name. Override to run more than one bot in one process. @default "telegram" */
  name?: string;
  /** Group chats eligible for a reply. Empty (default) = every group. Has no effect on DMs, which always reply. */
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
  /** Extra system-prompt section describing the delivery channel; passed through to `prepareChat`. @default "Channel: Telegram." */
  channelHint?: string;
  /** A throw/rejection is treated as "no persona" for that turn. `sender` is the namespaced `tg:<id>` key. */
  personaResolver?: (ctx: {
    sender: string;
    text: string;
  }) => string | undefined | Promise<string | undefined>;
  /** Off by default — the channel stays single-turn until a store is configured. */
  history?: { store: HistoryStore; limit?: number };
  muteRegex?: RegExp;
  unmuteRegex?: RegExp;
  /** Neutral, overridable acknowledgements — this module ships no bot personality; unset = silent mute/unmute. */
  muteReply?: string;
  unmuteReply?: string;
  dmRateLimit?: { max: number; windowMs: number };
  groupRateLimit?: { max: number; windowMs: number };
  /** @default 30 */
  pollTimeoutSeconds?: number;
  /** Resume point for `getUpdates`. Omitted = whatever Telegram still has queued (see docs/telegram.md). */
  initialOffset?: number;
  /** Called with each acknowledged offset, for a host that wants to persist it across restarts. */
  onOffset?: (offset: number) => void;
  /** Overridable for tests and for hosts routing through a proxy; defaults to `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** Self-hosted Bot API server origin. */
  apiBaseUrl?: string;
  /** Overridable for tests, which fake the Bot API instead of calling it; defaults to a `fetch` client over {@link TelegramChannelConfig.botToken}. */
  api?: TelegramApi;
  /** Overridable for tests; defaults to a `setTimeout`-based sleep. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Logger for poll/gate diagnostics. Falls back to the host's `deps.logger`, then a console logger. */
  logger?: Logger;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer === "object" && "unref" in timer) timer.unref();
  });
}

export function createTelegramChannel(config: TelegramChannelConfig): Channel {
  const channelName = config.name ?? "telegram";
  const allowedChats = config.allowedChats ?? [];
  const sleep = config.sleep ?? defaultSleep;
  const pollTimeoutSeconds = config.pollTimeoutSeconds ?? DEFAULT_POLL_TIMEOUT_SECONDS;

  let stopped = false;
  let registered = false;
  // Cuts the in-flight long poll on stop(): without it, teardown would block
  // for up to `pollTimeoutSeconds` waiting for Telegram to answer a request
  // whose result is already unwanted.
  let abort: AbortController | undefined;
  let senders: { unregister(name: string): void } | undefined;

  return {
    name: channelName,
    async start(deps) {
      const log = config.logger ?? deps.logger ?? createConsoleLogger();
      const api =
        config.api ??
        createTelegramApi({
          botToken: config.botToken,
          fetch: config.fetch,
          baseUrl: config.apiBaseUrl,
        });

      // Resolved eagerly, before returning: the bot's own id and username are
      // what mention and loop-guard detection compare against, so a channel
      // that polled without them would answer nothing in groups and could
      // answer itself in DMs. A bad token fails THIS start() call, which
      // `createServer` logs and isolates, instead of failing silently later
      // inside the poll loop.
      const me: TelegramBotIdentity = await api.getMe();
      const label = `Telegram[${me.username ?? me.id}]`;

      const sender: ChannelSender = {
        sendText: (chatId, text) => api.sendMessage(chatId, text),
        sendMedia: (chatId, payload) => api.sendMedia(chatId, payload),
        sendReaction: (chatId, messageRef, emoji) =>
          api.setMessageReaction(chatId, Number(messageRef), emoji),
      };
      deps.senders.register(channelName, sender);
      senders = deps.senders;
      registered = true;

      // Built once per start, not per update: gates, mute state and rate
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
          channelHint: config.channelHint ?? "Channel: Telegram.",
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

      // Chat ids already reported as blocked by the allowlist — a group id
      // isn't guessable in advance, so a host needs to see it once to add it,
      // and a chatty non-allowlisted group would otherwise flood the log.
      const loggedUnallowedChats = new Set<string>();

      async function handleUpdate(update: TelegramUpdate): Promise<void> {
        const message = update.message;
        const msg = toChannelMessage(update, me);
        if (!msg || !message) return;

        if (isBlockedByAllowlist(msg, { allowedChats })) {
          if (!loggedUnallowedChats.has(msg.chatId)) {
            loggedUnallowedChats.add(msg.chatId);
            log.warn(`${label}: skipped chat ${msg.chatId} - not in allowedChats`);
          }
        }

        const reply: InboundReplySender = {
          // Threaded onto the incoming message: in a busy group an untethered
          // answer reads as a non-sequitur.
          sendAnswer: (chatId, text) =>
            api.sendMessage(chatId, text, { replyToMessageId: message.message_id }),
          sendGateReply: (chatId, text) => api.sendMessage(chatId, text),
        };

        await pipeline(msg, {
          reply,
          conversationId: msg.chatId,
          sender: telegramSenderKey(msg.senderId),
        });
      }

      abort = new AbortController();
      const signal = abort.signal;

      // Not awaited: `start` must return once the transport is initiated, not
      // once polling ends (which is at shutdown).
      void runLongPoll({
        getUpdates: (offset) =>
          api.getUpdates({ offset, timeoutSeconds: pollTimeoutSeconds, signal }),
        handleUpdate,
        isStopped: () => stopped,
        sleep,
        initialOffset: config.initialOffset,
        onOffset: config.onOffset,
        logger: log,
        label,
      }).catch((error) => log.error(`${label}: poll loop ended unexpectedly:`, error));

      log.info(`${label}: polling for updates as @${me.username ?? me.id}`);
    },
    stop() {
      stopped = true;
      abort?.abort();
      if (registered) {
        senders?.unregister(channelName);
        registered = false;
      }
    },
  };
}
