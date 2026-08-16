/**
 * The per-sync-batch handling logic for the Matrix channel: room-invite
 * auto-join, `m.direct` account-data tracking, event -> `ChannelMessage`
 * mapping, and pipeline dispatch — the Matrix analogue of
 * `../telegram/handler.ts`, adapted to a `/sync` response covering several
 * rooms and events at once instead of one Telegram update.
 */

import type { Logger } from "../../core/logger";
import { isBlockedByAllowlist } from "../gates";
import type { InboundPipeline, InboundReplySender } from "../pipeline";
import type { ChannelSender } from "../senders";
import type { MatrixApi, MatrixSyncResponse } from "./api";
import {
  directInviteFrom,
  directMappingFromEvents,
  directMappingRooms,
  type MatrixDirectMapping,
  type MatrixIdentity,
  matrixSenderKey,
  recordSentEventId,
  toChannelMessage,
  withDirectRoom,
} from "./updates";

async function sendText(
  api: MatrixApi,
  roomId: string,
  text: string,
  sentEventIds: Set<string>,
  replyToEventId?: string,
): Promise<void> {
  const { eventId } = await api.sendEvent(roomId, {
    msgtype: "m.text",
    body: text,
    ...(replyToEventId
      ? { "m.relates_to": { "m.in_reply_to": { event_id: replyToEventId } } }
      : {}),
  });
  recordSentEventId(sentEventIds, eventId);
}

export interface MatrixSyncHandlerDeps {
  api: MatrixApi;
  me: MatrixIdentity;
  pipeline: InboundPipeline;
  /** Group rooms eligible for a reply. Empty = every room. */
  allowedChats: string[];
  /**
   * This session's own sent event ids, for reply-to-bot detection (see
   * `./updates`'s `isReplyToBot`) — shared with, and appended to by, the
   * `ChannelSender` this channel registers, so a reply sent outside a
   * pipeline turn (a scheduler, a flow) is still recognised.
   */
  sentEventIds: Set<string>;
  /**
   * Auto-accept room invites so the bot can actually receive messages there.
   * Gated by {@link MatrixSyncHandlerDeps.allowedChats} when that is set:
   * an invite is an unauthenticated request from any user on any federated
   * homeserver, so a configured allowlist governs which rooms the bot will
   * join, not just which ones it will answer in.
   * @default true
   */
  autoJoin?: boolean;
  /**
   * The bot's own `m.direct` mapping as of `start()` (see `./channel`'s
   * upfront `getAccountData("m.direct")` fetch), seeded here because an
   * initial `/sync` response's `account_data` isn't guaranteed to repeat
   * `m.direct` and a resumed sync (with `initialSince`) never carries it
   * again unless it changes, so without this a restart would treat every
   * known DM as an addressing-required group until it next changes.
   */
  initialDirect?: MatrixDirectMapping;
  logger: Logger;
  /** Log-line prefix, e.g. `Matrix[@bot:example.org]`. */
  label: string;
}

/**
 * One `/sync` response -> zero or more pipeline turns, one per
 * `m.room.message` event across every joined room in the batch. Builds its
 * own allowlist-log dedup set, so each transport instance gets its own
 * "skipped room" throttling rather than sharing (or fighting over) state
 * with another.
 */
export function createMatrixSyncHandler(
  deps: MatrixSyncHandlerDeps,
): (response: MatrixSyncResponse) => Promise<void> {
  const { api, me, pipeline, allowedChats, sentEventIds, logger, label } = deps;
  const autoJoin = deps.autoJoin ?? true;
  const loggedUnallowedChats = new Set<string>();
  const loggedDeclinedInvites = new Set<string>();
  let directMapping: MatrixDirectMapping = { ...(deps.initialDirect ?? {}) };
  let directRooms = directMappingRooms(directMapping);

  /**
   * Records a room the inviting client told us is a DM. The bot's own
   * `m.direct` is what DM detection reads at the next `start()`, and nothing
   * else ever writes it: the inviting client records the DM in its own
   * account data, not the bot's. Without this write every DM would come back
   * from a restart classified as a group, silently needing a mention.
   */
  async function rememberDirectRoom(peer: string, roomId: string): Promise<void> {
    directRooms.add(roomId);
    const merged = withDirectRoom(directMapping, peer, roomId);
    if (!merged) return;
    directMapping = merged;
    try {
      await api.setAccountData(me.userId, "m.direct", directMapping);
    } catch (error) {
      // Best effort: this session already treats the room as a DM in memory,
      // so a failed write only costs the next restart its head start.
      logger.warn(`${label}: could not record ${roomId} in m.direct:`, error);
    }
  }

  return async function handleSync(response) {
    // Only overwrite the known direct-message rooms when this batch actually
    // carries an `m.direct` event — an unrelated account-data change (a
    // push-rules update, say) has no `m.direct` entry, and treating its
    // *absence* as "no direct rooms" would wipe every DM this session has
    // already learned about back to "needs addressing".
    const syncedDirect = directMappingFromEvents(response.account_data?.events ?? []);
    if (syncedDirect) {
      directMapping = syncedDirect;
      directRooms = directMappingRooms(directMapping);
    }

    if (autoJoin) {
      for (const [roomId, room] of Object.entries(response.rooms?.invite ?? {})) {
        // An allowlist is the operator's list of rooms this bot belongs in.
        // Joining anything else on a stranger's invite puts the bot in rooms
        // it will then refuse to speak in, visible to whoever invited it.
        if (allowedChats.length > 0 && !allowedChats.includes(roomId)) {
          if (!loggedDeclinedInvites.has(roomId)) {
            loggedDeclinedInvites.add(roomId);
            logger.warn(`${label}: left invite to ${roomId} pending - not in allowedChats`);
          }
          continue;
        }
        const directInviter = directInviteFrom(room, me);
        try {
          await api.joinRoom(roomId);
          logger.info(`${label}: joined ${roomId} (accepted invite)`);
        } catch (error) {
          logger.warn(`${label}: failed to join ${roomId}:`, error);
          continue;
        }
        if (directInviter) await rememberDirectRoom(directInviter, roomId);
      }
    }

    for (const [roomId, room] of Object.entries(response.rooms?.join ?? {})) {
      for (const event of room.timeline.events) {
        const msg = toChannelMessage(roomId, event, me, directRooms, sentEventIds);
        if (!msg) continue;

        if (isBlockedByAllowlist(msg, { allowedChats })) {
          if (!loggedUnallowedChats.has(msg.chatId)) {
            loggedUnallowedChats.add(msg.chatId);
            logger.warn(`${label}: skipped room ${msg.chatId} - not in allowedChats`);
          }
        }

        const reply: InboundReplySender = {
          // Threaded onto the incoming event: in a busy room an untethered
          // answer reads as a non-sequitur.
          sendAnswer: (chatId, text) => sendText(api, chatId, text, sentEventIds, event.event_id),
          sendGateReply: (chatId, text) => sendText(api, chatId, text, sentEventIds),
        };

        try {
          await pipeline(msg, {
            reply,
            conversationId: msg.chatId,
            sender: matrixSenderKey(msg.senderId),
          });
        } catch (error) {
          // One event's handling failing (a throwing answerFn, a delivery
          // error) must not cost every other event still in this batch —
          // the `since` token has already advanced past this whole batch by
          // the time the sync loop calls this handler, so a bare throw here
          // would silently drop every remaining room and event in it, not
          // just this one.
          logger.warn(`${label}: message ${event.event_id} in ${roomId} handling failed:`, error);
        }
      }
    }
  };
}

/** The `ChannelSender` every Matrix transport registers — text, media and reactions over the same `MatrixApi`. */
export function createMatrixSender(api: MatrixApi, sentEventIds: Set<string>): ChannelSender {
  return {
    sendText: (chatId, text) => sendText(api, chatId, text, sentEventIds),
    sendMedia: async (chatId, payload) => {
      const { eventId } = await api.sendMedia(chatId, payload);
      recordSentEventId(sentEventIds, eventId);
    },
    sendReaction: (chatId, messageRef, emoji) =>
      api
        .sendEvent(
          chatId,
          {
            "m.relates_to": { rel_type: "m.annotation", event_id: String(messageRef), key: emoji },
          },
          { eventType: "m.reaction" },
        )
        .then(() => undefined),
  };
}
