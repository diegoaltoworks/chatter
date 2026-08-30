/**
 * The per-update handling logic shared by both Telegram transports: the
 * long-poll loop (`./channel`, via `./poll`) and the webhook route
 * (`./webhook`). Kept in one place so addressing, allowlist logging and
 * pipeline dispatch are defined exactly once — a second copy would drift the
 * moment one transport's gate behaviour changed and the other didn't.
 */

import type { Logger } from "../../core/logger";
import { isBlockedByAllowlist, type SessionIdentityRegistry } from "../gates";
import type { InboundPipeline, InboundReplySender } from "../pipeline";
import type { ChannelSender } from "../senders";
import type { TelegramApi, TelegramUpdate } from "./api";
import { type TelegramBotIdentity, telegramSenderKey, toChannelMessage } from "./updates";

export interface TelegramUpdateHandlerDeps {
  api: TelegramApi;
  me: TelegramBotIdentity;
  pipeline: InboundPipeline;
  /**
   * Every identity this process answers to, across all its channels - what
   * `fromBot` is resolved against, so another endpoint of the same process is
   * recognised as "us". Omitted: `me` alone, which cannot see a second bot.
   */
  identities?: SessionIdentityRegistry;
  /** Group chats eligible for a reply. Empty = every group. */
  allowedChats: string[];
  logger: Logger;
  /** Log-line prefix, e.g. `Telegram[mybot]`. */
  label: string;
  /** This channel's configured name - populates `ChannelMessage.endpointId`. Omitted: `endpointId` is left unset. */
  channelName?: string;
}

/**
 * One update -> one pipeline turn. Builds its own allowlist-log dedup set, so
 * each transport instance gets its own "skipped chat" throttling rather than
 * sharing (or fighting over) state with another.
 */
export function createTelegramUpdateHandler(
  deps: TelegramUpdateHandlerDeps,
): (update: TelegramUpdate) => Promise<void> {
  const { api, me, pipeline, identities, allowedChats, logger, label, channelName } = deps;
  const loggedUnallowedChats = new Set<string>();

  return async function handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    const msg = toChannelMessage(update, me, identities, channelName);
    if (!msg || !message) return;

    if (isBlockedByAllowlist(msg, { allowedChats })) {
      if (!loggedUnallowedChats.has(msg.chatId)) {
        loggedUnallowedChats.add(msg.chatId);
        logger.warn(`${label}: skipped chat ${msg.chatId} - not in allowedChats`);
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
  };
}

/** The `ChannelSender` every Telegram transport registers — text, media and reactions over the same `TelegramApi`, regardless of how updates arrive. */
export function createTelegramSender(api: TelegramApi): ChannelSender {
  return {
    sendText: (chatId, text) => api.sendMessage(chatId, text),
    sendMedia: (chatId, payload) => api.sendMedia(chatId, payload),
    sendReaction: (chatId, messageRef, emoji) =>
      api.setMessageReaction(chatId, Number(messageRef), emoji),
  };
}
