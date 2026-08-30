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
 * separate modules). `./webhook` is the alternative transport for hosts that
 * would rather receive updates over HTTPS than long-poll; the two share
 * their update-handling logic via `./handler` so gate behaviour never
 * diverges between them — see docs/telegram.md on choosing a mode.
 *
 * One caveat worth knowing before choosing this over a user-mode client: a bot
 * cannot start a conversation (the user must message it first), and in groups
 * Telegram's privacy mode means it only receives messages that address it —
 * which is the same policy `decideChannelAction` applies anyway.
 */

import { createConsoleLogger } from "../../core/logger";
import type { Channel } from "../index";
import { createInboundPipeline, resolveBrainHooks } from "../pipeline";
import { defaultSleep, type PollingChannelConfig } from "../polling";
import { createTelegramApi, type TelegramApi } from "./api";
import { createTelegramSender, createTelegramUpdateHandler } from "./handler";
import { runLongPoll } from "./poll";
import { type TelegramBotIdentity, telegramOwnIdentities } from "./updates";

/** Long-poll hold time. Telegram holds the request open this long when no update arrives, so a poll is one request per 30s idle — not a busy loop. */
const DEFAULT_POLL_TIMEOUT_SECONDS = 30;

export interface TelegramChannelConfig extends PollingChannelConfig {
  /** From @BotFather. A credential — pass it from the environment, never commit it. */
  botToken: string;
  /** Channel and sender-registry name. Override to run more than one bot in one process. @default "telegram" */
  name?: string;
  /** Extra system-prompt section describing the delivery channel; passed through to `prepareChat`. @default "Channel: Telegram." */
  channelHint?: string;
  /** A throw/rejection is treated as "no persona" for that turn. `sender` is the namespaced `tg:<id>` key. */
  personaResolver?: (ctx: {
    sender: string;
    text: string;
    /** Which of this process's endpoints received the message - see `ChannelMessage.endpointId`. Unset unless the channel runs more than one. */
    endpointId?: string;
  }) => string | undefined | Promise<string | undefined>;
  /** @default 30 */
  pollTimeoutSeconds?: number;
  /** Resume point for `getUpdates`. Omitted = whatever Telegram still has queued (see docs/telegram.md). */
  initialOffset?: number;
  /** Called with each acknowledged offset, for a host that wants to persist it across restarts. */
  onOffset?: (offset: number) => void;
  /** Self-hosted Bot API server origin. */
  apiBaseUrl?: string;
  /** Overridable for tests, which fake the Bot API instead of calling it; defaults to a `fetch` client over {@link TelegramChannelConfig.botToken}. */
  api?: TelegramApi;
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

      // Registered before the first poll, so this channel's very first
      // inbound resolves against a complete view of the server's identities.
      // Never removed - see SessionIdentityRegistry.
      const identities = config.identities ?? deps.identities;
      identities.set(channelName, telegramOwnIdentities(me));

      deps.senders.register(channelName, createTelegramSender(api));
      senders = deps.senders;
      registered = true;

      // Built once per start, not per update: gates, mute state and rate
      // limiters live in this closure.
      const pipeline = createInboundPipeline(
        { client: deps.client, store: deps.store, prompts: deps.prompts },
        {
          channel: channelName,
          ...resolveBrainHooks(config, deps.config),
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

      const handleUpdate = createTelegramUpdateHandler({
        api,
        me,
        identities,
        pipeline,
        allowedChats,
        logger: log,
        label,
        // config.name, not the resolved channelName: endpointId opts in only
        // when the host explicitly named this channel (running more than
        // one bot in the process), not for a default single-token channel.
        channelName: config.name,
      });

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
