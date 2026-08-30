/**
 * Telegram Bot API transport: a `CustomRoutes` mount that receives updates
 * over HTTPS instead of long-polling `getUpdates` (see `./channel` for that
 * transport). Update handling is identical between the two — both build on
 * `./handler`'s shared `createTelegramUpdateHandler`/`createTelegramSender` —
 * so choosing one over the other is purely an infrastructure decision: a
 * webhook needs a publicly reachable HTTPS endpoint and no open connection,
 * long-polling needs neither but holds one request open at a time. See
 * docs/telegram.md for the full comparison and `TelegramApi.setWebhook` for
 * registering the URL with Telegram once this route is mounted.
 *
 * ```ts
 * await createServer({
 *   ...,
 *   customRoutes: createTelegramWebhookRoute({
 *     botToken: process.env.TELEGRAM_BOT_TOKEN as string,
 *     webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET as string,
 *   }),
 * });
 * ```
 */

import { timingSafeEqual } from "node:crypto";
import { createConsoleLogger, type Logger } from "../../core/logger";
import type { HistoryCompactionOptions } from "../../history/compaction";
import type { HistoryStore } from "../../history/types";
import { chatBodyLimit } from "../../middleware/bodyLimit";
import type { BrainHooks, CustomRoutes } from "../../types";
import type { SessionIdentityRegistry } from "../gates";
import { createInboundPipeline, resolveBrainHooks } from "../pipeline";
import { createTelegramApi, type TelegramApi, type TelegramUpdate } from "./api";
import { createTelegramSender, createTelegramUpdateHandler } from "./handler";
import { telegramOwnIdentities } from "./updates";

/** Header Telegram echoes back on every webhook POST, carrying whatever `secretToken` was passed to `setWebhook`. */
const SECRET_TOKEN_HEADER = "x-telegram-bot-api-secret-token";

export interface TelegramWebhookConfig extends BrainHooks {
  /** From @BotFather. A credential — pass it from the environment, never commit it. */
  botToken: string;
  /**
   * Shared secret Telegram is told about via `setWebhook({ secretToken })`
   * and then echoes back on every POST as `X-Telegram-Bot-Api-Secret-Token`.
   * Required: without one there is no way to tell a genuine Telegram POST
   * from a forged one, so this fails closed by construction — a missing or
   * blank value throws rather than falling back to accepting every request.
   */
  webhookSecret: string;
  /** Where the route is mounted. @default "/webhooks/telegram" */
  path?: string;
  /** Channel and sender-registry name. Override to run more than one bot in one process. @default "telegram" */
  name?: string;
  /** Group chats eligible for a reply. Empty (default) = every group. Has no effect on DMs, which always reply. */
  allowedChats?: string[];
  /**
   * Every identity this process answers to, keyed by endpoint - what `fromBot`
   * is resolved against, so one of your own bots is never answered as a
   * stranger. @default `deps.identities`, the one registry `createServer`
   * owns and shares with every channel.
   */
  identities?: SessionIdentityRegistry;
  model?: string;
  /** Extra system-prompt section describing the delivery channel; passed through to `prepareChat`. @default "Channel: Telegram." */
  channelHint?: string;
  /** A throw/rejection is treated as "no persona" for that turn. `sender` is the namespaced `tg:<id>` key. */
  personaResolver?: (ctx: {
    sender: string;
    text: string;
  }) => string | undefined | Promise<string | undefined>;
  /** Off by default — the channel stays single-turn until a store is configured. */
  history?: {
    store: HistoryStore;
    /** Most recent turns to load per reply. @default 20 */
    limit?: number;
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
  muteReply?: string;
  unmuteReply?: string;
  dmRateLimit?: { max: number; windowMs: number };
  groupRateLimit?: { max: number; windowMs: number };
  now?: () => number;
  /** Overridable for tests and for hosts routing through a proxy; defaults to `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** Self-hosted Bot API server origin. */
  apiBaseUrl?: string;
  /** Overridable for tests, which fake the Bot API instead of calling it; defaults to a `fetch` client over {@link TelegramWebhookConfig.botToken}. */
  api?: TelegramApi;
  logger?: Logger;
}

/**
 * Constant-time secret comparison — a plain `===` would let response timing
 * leak the secret one byte at a time to an attacker probing the endpoint.
 */
function secureCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/** What `setWebhook`'s `secret_token` parameter accepts — see https://core.telegram.org/bots/api#setwebhook. A value outside this charset would never be accepted by Telegram, so it can only mean a misconfigured env var; rejecting it here surfaces that at boot instead of as an endpoint that 403s every genuine POST forever. */
const SECRET_TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;

/**
 * Builds a `CustomRoutes` mount that receives Telegram updates over HTTPS.
 * Throws synchronously if `webhookSecret` is missing, blank, or outside the
 * charset Telegram accepts for it — before the route ever exists, rather
 * than mounting an endpoint that would silently accept everything or reject
 * every request.
 */
export function createTelegramWebhookRoute(config: TelegramWebhookConfig): CustomRoutes {
  const webhookSecret = config.webhookSecret;
  if (!webhookSecret?.trim()) {
    throw new Error("Telegram webhook requires webhookSecret (it fails closed without one)");
  }
  if (!SECRET_TOKEN_PATTERN.test(webhookSecret)) {
    throw new Error(
      "Telegram webhookSecret must match /^[A-Za-z0-9_-]{1,256}$/ (Telegram's own secret_token charset)",
    );
  }
  const channelName = config.name ?? "telegram";
  const allowedChats = config.allowedChats ?? [];
  const path = config.path ?? "/webhooks/telegram";

  return async (app, deps) => {
    const log = config.logger ?? deps.logger ?? createConsoleLogger();
    const api =
      config.api ??
      createTelegramApi({
        botToken: config.botToken,
        fetch: config.fetch,
        baseUrl: config.apiBaseUrl,
      });

    // Resolved eagerly, so a bad token fails webhook mounting immediately at
    // boot rather than 500ing on the first real POST with no useful log.
    // Unlike a Channel's start() — which `createServer` isolates in its own
    // try/catch so one broken transport can't take the rest down — a
    // `customRoutes` mount is awaited bare (see server.ts), so a bad token
    // here fails the WHOLE server's startup, not just this transport.
    const me = await api.getMe();
    const label = `Telegram[${me.username ?? me.id}] (webhook)`;

    // Registered before the route is mounted, so the first POST already
    // resolves against a complete view of this process's own identities.
    const identities = config.identities ?? deps.identities;
    identities.set(channelName, telegramOwnIdentities(me));

    deps.senders.register(channelName, createTelegramSender(api));

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
      // when the host explicitly named this channel (running more than one
      // bot in the process), not for a default single-token channel.
      channelName: config.name,
    });

    app.post(
      path,
      chatBodyLimit(deps.config.server?.maxRequestBytes), // Reject oversized bodies first
      async (c) => {
        const provided = c.req.header(SECRET_TOKEN_HEADER);
        if (!provided || !secureCompare(provided, webhookSecret)) {
          log.warn(`${label}: rejected webhook POST - missing or invalid secret token`);
          return c.text("", 403);
        }

        let body: unknown;
        try {
          body = await c.req.json();
        } catch {
          return c.text("", 400);
        }
        if (typeof body !== "object" || body === null) {
          return c.text("", 400);
        }
        const update = body as TelegramUpdate;

        // A handler throw must not become a 5xx: Telegram treats a non-2xx
        // as "retry this update later", and retrying forever on one poison
        // update would wedge delivery the same way an unguarded long poll
        // would.
        //
        // Unlike poll.ts (whose offset advances BEFORE the update is
        // handled, so a slow or hung handler never blocks acknowledgement),
        // this response only returns after the full pipeline — gates,
        // retrieval, the model call — completes. A handler slow enough to
        // miss Telegram's own webhook timeout gets its update redelivered,
        // which can produce a duplicate reply. Keep `answerFn` latency
        // reasonable, or use long-poll mode if that risk isn't acceptable.
        try {
          await handleUpdate(update);
        } catch (error) {
          log.warn(`${label}: update handling failed:`, error);
        }

        return c.text("", 200);
      },
    );

    log.info(`${label}: webhook mounted at ${path} as @${me.username ?? me.id}`);
  };
}
