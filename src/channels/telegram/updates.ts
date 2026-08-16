/**
 * Telegram update -> {@link ChannelMessage}: the transport's own half of the
 * channel contract (see docs/build-a-channel.md), kept pure so mention and
 * reply-to detection are testable without a network or a running channel.
 *
 * Addressing parity with WhatsApp is the point of this module. WhatsApp
 * resolves "was the bot addressed?" from `contextInfo.mentionedJid` and the
 * quoted participant; Telegram resolves it from message entities and
 * `reply_to_message.from`. The gate policy that consumes those booleans
 * (`decideChannelAction`) is identical for both.
 */

import type { ChannelMessage } from "../gates";
import type { TelegramMessage, TelegramMessageEntity, TelegramUpdate } from "./api";

/** The bot's own identity, as `getMe` reports it. */
export interface TelegramBotIdentity {
  id: number;
  username?: string;
}

/** The message's text: plain text, or a photo/video/document caption. */
export function messageText(message: TelegramMessage): string {
  return message.text ?? message.caption ?? "";
}

/** Entities belong to whichever field carried the text — captions carry theirs on `caption_entities`. */
export function messageEntities(message: TelegramMessage): TelegramMessageEntity[] {
  return (message.text !== undefined ? message.entities : message.caption_entities) ?? [];
}

/**
 * Did this message address the bot? Three ways it can, all of which a human
 * reader would call "addressed":
 *
 * - a `mention` entity whose text is the bot's `@username`;
 * - a `text_mention` entity pointing at the bot's user id (how a mention
 *   arrives when the mentioned account has no username);
 * - a `bot_command` entity suffixed with the bot's username (`/ask@mybot`),
 *   which is how Telegram disambiguates commands between several bots in one
 *   group.
 *
 * Username comparison is case-insensitive: Telegram treats `@MyBot` and
 * `@mybot` as the same handle, and clients preserve whatever the sender typed.
 */
export function mentionsBot(message: TelegramMessage, me: TelegramBotIdentity): boolean {
  const text = messageText(message);
  const handle = me.username ? `@${me.username.toLowerCase()}` : undefined;

  return messageEntities(message).some((entity) => {
    if (entity.type === "text_mention") return entity.user?.id === me.id;
    if (!handle) return false;
    const token = text.slice(entity.offset, entity.offset + entity.length).toLowerCase();
    if (entity.type === "mention") return token === handle;
    if (entity.type === "bot_command") return token.endsWith(handle);
    return false;
  });
}

/**
 * The {@link ChannelMessage} for an update, or `undefined` when there is
 * nothing for a chat pipeline to look at: a non-message update, a channel post
 * (which has no `from`, only a `sender_chat`), or a service message.
 *
 * A message with no text at all (a sticker, an uncaptioned photo) still maps —
 * its blank text is dropped by `decideChannelAction` like any other, and
 * mapping it keeps this function's rule simple: interpret the wire, let the
 * gates decide policy.
 */
export function toChannelMessage(
  update: TelegramUpdate,
  me: TelegramBotIdentity,
): ChannelMessage | undefined {
  const message = update.message;
  if (!message?.from) return undefined;

  return {
    chatId: String(message.chat.id),
    senderId: String(message.from.id),
    text: messageText(message),
    isDirectMessage: message.chat.type === "private",
    mentionsBot: mentionsBot(message, me),
    isReplyToBot: message.reply_to_message?.from?.id === me.id,
    // A single bot token is a single identity, so unlike WhatsApp's
    // multi-session loop guard this is a plain equality check.
    fromBot: message.from.id === me.id,
    // What `setMessageReaction` targets — see `ChannelSenderRegistry.sendReaction`.
    messageRef: message.message_id,
  };
}

/**
 * The `offset` to request next so `update` is never redelivered:
 * `update_id + 1`, which is also how the Bot API acknowledges it (there is no
 * separate ack call — see docs/telegram.md on offset persistence).
 */
export function nextOffset(update: TelegramUpdate): number {
  return update.update_id + 1;
}

/**
 * A stable identity key for `bucketsFor`/`personaResolver`/`answerFn`. Namespaced
 * because a bare Telegram user id is a numeral with no channel in it — a host
 * keying persona or spend state across several channels must not have one
 * collide with a phone number or another transport's numeric id (the same
 * reasoning as WhatsApp's explicit `lid:` marker).
 */
export function telegramSenderKey(senderId: string): string {
  return `tg:${senderId}`;
}
