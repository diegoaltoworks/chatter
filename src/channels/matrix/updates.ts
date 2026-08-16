/**
 * Matrix room event -> {@link ChannelMessage}: the transport's own half of
 * the channel contract (see docs/build-a-channel.md), kept pure so mention,
 * reply-to and DM detection are testable without a network or a running
 * channel.
 *
 * Addressing parity with the other built-in channels is the point of this
 * module. WhatsApp and Telegram both resolve "was the bot addressed?" from
 * transport-native structures; Matrix resolves it from the stable
 * `m.mentions` field (MSC3952, in the spec since v1.7) with a pill-in-HTML
 * fallback for clients that only set that. The gate policy that consumes
 * those booleans (`decideChannelAction`) is identical for every channel.
 */

import type { ChannelMessage } from "../gates";
import type { MatrixAccountDataEvent, MatrixEvent } from "./api";

/** The bot's own identity, as `whoami` reports it. */
export interface MatrixIdentity {
  userId: string;
}

interface MatrixMentions {
  user_ids?: string[];
  room?: boolean;
}

interface MatrixInReplyTo {
  event_id?: string;
}

interface MatrixMessageContent {
  msgtype?: string;
  body?: string;
  format?: string;
  formatted_body?: string;
  "m.mentions"?: MatrixMentions;
  "m.relates_to"?: { "m.in_reply_to"?: MatrixInReplyTo };
}

/** The message text, or "" for an event this channel doesn't render as text (a redaction, a non-text msgtype with no body). */
export function messageText(content: MatrixMessageContent): string {
  return content.body ?? "";
}

/**
 * Did this message address the bot? Two ways it can:
 *
 * - `content["m.mentions"].user_ids` includes the bot's user id — the
 *   stable, intentional-mentions mechanism every current client sets;
 * - a matrix.to pill for the bot's user id inside `formatted_body`, for a
 *   client that renders a mention as HTML without also setting `m.mentions`.
 *
 * The bot's name in plain-text prose, with neither of those, is not an
 * invitation — the same rule Telegram and WhatsApp apply.
 */
const PILL_HREF_PATTERN = /href=["']([^"']+)["']/g;

/**
 * The Matrix user id a `matrix.to` pill link points at, or `undefined` for a
 * link that isn't one. Compares on the decoded, query-stripped fragment
 * rather than a raw substring match: a pill's user id segment is commonly
 * percent-encoded (`%40bot%3Aexample.org` for `@bot:example.org`, per the
 * matrix.to spec) and can carry a trailing `?via=...` routing hint that a
 * plain `includes()` would never match around.
 */
function pillUserId(href: string): string | undefined {
  const fragment = href.split("https://matrix.to/#/")[1];
  if (!fragment) return undefined;
  try {
    return decodeURIComponent(fragment.split("?")[0] ?? "");
  } catch {
    return undefined;
  }
}

export function mentionsBot(content: MatrixMessageContent, me: MatrixIdentity): boolean {
  if (content["m.mentions"]?.user_ids?.includes(me.userId)) return true;
  const formatted = content.formatted_body;
  if (!formatted) return false;
  for (const match of formatted.matchAll(PILL_HREF_PATTERN)) {
    if (pillUserId(match[1] ?? "") === me.userId) return true;
  }
  return false;
}

/**
 * Was this message a reply to one the bot sent? `sentEventIds` is the
 * session's own record of event ids it has sent (see `./channel`) — Matrix
 * has no cheap "who sent event X" lookup without fetching that event, and a
 * bot only ever needs to recognise its OWN messages, which it already knows
 * without asking the server.
 */
export function isReplyToBot(
  content: MatrixMessageContent,
  sentEventIds: ReadonlySet<string>,
): boolean {
  const replyToId = content["m.relates_to"]?.["m.in_reply_to"]?.event_id;
  return replyToId ? sentEventIds.has(replyToId) : false;
}

/** How many of the session's own sent event ids {@link isReplyToBot} remembers — bounded so a long-running bot's memory doesn't grow with every message it ever sent. */
export const MAX_TRACKED_SENT_EVENTS = 500;

/** Records `eventId` as one of ours, evicting the oldest entry first once the set is at capacity (`Set` iterates in insertion order, so the first value is the oldest). */
export function recordSentEventId(sentEventIds: Set<string>, eventId: string): void {
  sentEventIds.add(eventId);
  if (sentEventIds.size > MAX_TRACKED_SENT_EVENTS) {
    const oldest = sentEventIds.values().next().value;
    if (oldest !== undefined) sentEventIds.delete(oldest);
  }
}

/**
 * Room ids the homeserver's `m.direct` account data lists as direct
 * messages, across every peer — the canonical way a Matrix client (and so a
 * bot) tells a DM from a group: there is no per-room "this is a DM" flag.
 * A room absent from this set is treated as a group and needs addressing,
 * the safer default when a client never populated `m.direct` for it.
 */
export function directRoomIds(accountDataEvents: MatrixAccountDataEvent[]): Set<string> {
  const direct = accountDataEvents.find((event) => event.type === "m.direct");
  const mapping = (direct?.content ?? {}) as Record<string, unknown>;
  const rooms = new Set<string>();
  for (const value of Object.values(mapping)) {
    if (Array.isArray(value)) {
      for (const roomId of value) {
        if (typeof roomId === "string") rooms.add(roomId);
      }
    }
  }
  return rooms;
}

/**
 * The {@link ChannelMessage} for a timeline event, or `undefined` when
 * there is nothing for a chat pipeline to look at: not an `m.room.message`
 * (a reaction, a membership change, an encrypted event this channel can't
 * decrypt), or one with no `msgtype` at all (a redacted message).
 */
export function toChannelMessage(
  roomId: string,
  event: MatrixEvent,
  me: MatrixIdentity,
  directRooms: ReadonlySet<string>,
  sentEventIds: ReadonlySet<string>,
): ChannelMessage | undefined {
  if (event.type !== "m.room.message") return undefined;
  const content = event.content as MatrixMessageContent;
  if (!content.msgtype) return undefined;

  return {
    chatId: roomId,
    senderId: event.sender,
    text: messageText(content),
    isDirectMessage: directRooms.has(roomId),
    mentionsBot: mentionsBot(content, me),
    isReplyToBot: isReplyToBot(content, sentEventIds),
    fromBot: event.sender === me.userId,
    messageRef: event.event_id,
  };
}

/**
 * A stable identity key for `bucketsFor`/`personaResolver`/`answerFn`.
 * Namespaced so a bare Matrix user id (which is itself already `@user:
 * server.tld`, unlike Telegram's bare numeral) never collides with another
 * channel's key when a host shares persona/spend state across channels.
 */
export function matrixSenderKey(userId: string): string {
  return `mx:${userId}`;
}
