/**
 * Channel-agnostic outbound registry. Brain-side features (a scheduler, the
 * flows engine) send messages by channel name without importing a transport
 * or knowing whether it is currently connected — a channel registers its
 * sender on start and unregisters it on stop, and every send degrades to
 * `false` instead of throwing when the name is unknown or the underlying
 * send fails, so a disconnected channel can never crash a caller.
 */

import { createConsoleLogger, type Logger } from "../core/logger";

/** What a channel implements to receive outbound sends. Voice/media payload shapes are transport-defined. */
export interface ChannelSender {
  sendText(chatId: string, text: string): Promise<void>;
  /** Optional: channels without voice support (or test fakes) stay valid without it. */
  sendVoice?(chatId: string, payload: unknown): Promise<void>;
  /** Optional: channels without media support (or test fakes) stay valid without it. */
  sendMedia?(chatId: string, payload: unknown): Promise<void>;
  /**
   * Optional: channels without reaction support (or test fakes) stay valid
   * without it. `messageRef` is transport-defined — WhatsApp's is the
   * Baileys message key (see `ChannelMessage.messageRef`).
   */
  sendReaction?(chatId: string, messageRef: unknown, emoji: string): Promise<void>;
}

export interface ChannelSenderRegistry {
  register(name: string, sender: ChannelSender): void;
  unregister(name: string): void;
  /** True when a sender is registered under `name` (regardless of what it optionally supports). */
  available(name: string): boolean;
  sendText(name: string, chatId: string, text: string): Promise<boolean>;
  /** False (not a throw) when the sender is missing, disconnected, or lacks voice support. */
  sendVoice(name: string, chatId: string, payload: unknown): Promise<boolean>;
  /** False (not a throw) when the sender is missing, disconnected, or lacks media support. */
  sendMedia(name: string, chatId: string, payload: unknown): Promise<boolean>;
  /** False (not a throw) when the sender is missing, disconnected, or lacks reaction support. */
  sendReaction(name: string, chatId: string, messageRef: unknown, emoji: string): Promise<boolean>;
}

/** One registry per server: channels register on start, callers send by name. */
export function createSenderRegistry(
  logger: Logger = createConsoleLogger(),
): ChannelSenderRegistry {
  const senders = new Map<string, ChannelSender>();

  return {
    register(name, sender) {
      if (senders.has(name)) {
        logger.warn(`Channel sender "${name}" is already registered; overwriting.`);
      }
      senders.set(name, sender);
    },
    unregister(name) {
      senders.delete(name);
    },
    available(name) {
      return senders.has(name);
    },
    async sendText(name, chatId, text) {
      const sender = senders.get(name);
      if (!sender) return false;
      try {
        await sender.sendText(chatId, text);
        return true;
      } catch (error) {
        logger.warn(`Channel sender "${name}" sendText failed:`, error);
        return false;
      }
    },
    async sendVoice(name, chatId, payload) {
      const sender = senders.get(name);
      if (!sender?.sendVoice) return false;
      try {
        await sender.sendVoice(chatId, payload);
        return true;
      } catch (error) {
        logger.warn(`Channel sender "${name}" sendVoice failed:`, error);
        return false;
      }
    },
    async sendMedia(name, chatId, payload) {
      const sender = senders.get(name);
      if (!sender?.sendMedia) return false;
      try {
        await sender.sendMedia(chatId, payload);
        return true;
      } catch (error) {
        logger.warn(`Channel sender "${name}" sendMedia failed:`, error);
        return false;
      }
    },
    async sendReaction(name, chatId, messageRef, emoji) {
      const sender = senders.get(name);
      if (!sender?.sendReaction) return false;
      try {
        await sender.sendReaction(chatId, messageRef, emoji);
        return true;
      } catch (error) {
        logger.warn(`Channel sender "${name}" sendReaction failed:`, error);
        return false;
      }
    },
  };
}
