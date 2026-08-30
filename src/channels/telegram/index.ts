/**
 * Telegram Bot API transport — a {@link Channel} with NO optional peer
 * dependency: the Bot API is JSON over HTTPS, reached with plain `fetch`, so
 * this subpath costs a consumer nothing beyond the package itself.
 *
 * ```ts
 * import { createTelegramChannel } from "@diegoaltoworks/chatter/telegram";
 *
 * await createServer({
 *   ...,
 *   channels: [createTelegramChannel({ botToken: process.env.TELEGRAM_BOT_TOKEN as string })],
 * });
 * ```
 *
 * Everything past turning an update into a `ChannelMessage` runs through
 * `./channels`' `createInboundPipeline`, shared with every other channel — see
 * docs/telegram.md for configuration and docs/build-a-channel.md for the SPI
 * this implements.
 *
 * `createTelegramWebhookRoute` is the alternative to `createTelegramChannel`:
 * updates over an HTTPS webhook instead of long-polling, mounted via
 * `ChatterConfig.customRoutes` — see docs/telegram.md for choosing between
 * the two.
 *
 * @packageDocumentation
 */

export {
  createTelegramApi,
  redactToken,
  splitTelegramText,
  TELEGRAM_API_BASE,
  TELEGRAM_TEXT_LIMIT,
  type TelegramApi,
  type TelegramApiConfig,
  TelegramApiError,
  type TelegramChat,
  type TelegramMediaPayload,
  type TelegramMessage,
  type TelegramMessageEntity,
  type TelegramUpdate,
  type TelegramUser,
  toTelegramMediaRequest,
} from "./api";
export { createTelegramChannel, type TelegramChannelConfig } from "./channel";
export {
  createTelegramSender,
  createTelegramUpdateHandler,
  type TelegramUpdateHandlerDeps,
} from "./handler";
export { type LongPollDeps, pollBackoffMs, retryDelayMs, runLongPoll } from "./poll";
export {
  mentionsBot,
  messageEntities,
  messageText,
  nextOffset,
  type TelegramBotIdentity,
  telegramOwnIdentities,
  telegramSenderKey,
  toChannelMessage,
} from "./updates";
export { createTelegramWebhookRoute, type TelegramWebhookConfig } from "./webhook";
