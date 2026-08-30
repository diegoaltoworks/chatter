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

import { type ChannelMessage, isEffectivelyFromSelf, type SessionIdentityRegistry } from "../gates";
import type { MatrixAccountDataEvent, MatrixEvent, MatrixInvitedRoom } from "./api";

/** Shared so the common no-registry call does not allocate a Map per message. */
const NO_IDENTITIES: SessionIdentityRegistry = new Map();

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

interface MatrixRelatesTo {
  /** `m.replace` for an edit, `m.annotation` for a reaction, `m.thread` for a threaded message. Absent on a plain reply. */
  rel_type?: string;
  event_id?: string;
  "m.in_reply_to"?: MatrixInReplyTo;
}

interface MatrixMessageContent {
  msgtype?: string;
  body?: string;
  format?: string;
  formatted_body?: string;
  "m.mentions"?: MatrixMentions;
  "m.relates_to"?: MatrixRelatesTo;
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
 * The `m.direct` account-data document: peer user id -> the rooms that are
 * direct messages with that peer. Matrix has no per-room "this is a DM"
 * flag, so this mapping is the only thing that tells one from a group.
 */
export type MatrixDirectMapping = Record<string, string[]>;

/** Raw `m.direct` content (whatever the homeserver stored) narrowed to peer -> room ids, dropping any entry that isn't a non-empty array of strings. */
export function toDirectMapping(content: Record<string, unknown> | undefined): MatrixDirectMapping {
  const mapping: MatrixDirectMapping = {};
  for (const [peer, value] of Object.entries(content ?? {})) {
    if (!Array.isArray(value)) continue;
    const rooms = value.filter((roomId): roomId is string => typeof roomId === "string");
    if (rooms.length > 0) mapping[peer] = rooms;
  }
  return mapping;
}

/** Every room id in a mapping, across every peer. A room absent from it is treated as a group and needs addressing, the safer default. */
export function directMappingRooms(mapping: MatrixDirectMapping): Set<string> {
  return new Set(Object.values(mapping).flat());
}

/** The `m.direct` mapping carried by a sync batch's account data, or `undefined` when this batch says nothing about it (an unrelated account-data change must not be read as "no DMs"). */
export function directMappingFromEvents(
  accountDataEvents: MatrixAccountDataEvent[],
): MatrixDirectMapping | undefined {
  const direct = accountDataEvents.find((event) => event.type === "m.direct");
  return direct ? toDirectMapping(direct.content) : undefined;
}

/** Room ids the homeserver's `m.direct` account data lists as direct messages, across every peer. */
export function directRoomIds(accountDataEvents: MatrixAccountDataEvent[]): Set<string> {
  return directMappingRooms(directMappingFromEvents(accountDataEvents) ?? {});
}

/**
 * `mapping` with `roomId` recorded against `peer`, or `undefined` when it is
 * already there, which the caller uses to skip a pointless account-data
 * write. Never mutates the input: `m.direct` is a whole-document PUT, so the
 * merged copy is what gets sent.
 */
export function withDirectRoom(
  mapping: MatrixDirectMapping,
  peer: string,
  roomId: string,
): MatrixDirectMapping | undefined {
  const existing = mapping[peer] ?? [];
  if (existing.includes(roomId)) return undefined;
  return { ...mapping, [peer]: [...existing, roomId] };
}

/**
 * The inviting user id when this invite is for a direct-message room, else
 * `undefined`.
 *
 * A client opening a DM sets `is_direct: true` on the `m.room.member` invite
 * it sends the bot, and records the room in ITS OWN `m.direct`, never in the
 * bot's. The invite is therefore the only moment the bot is told a room is a
 * DM; `./handler` seeds its DM set from this and writes the room into the
 * bot's own `m.direct` so a later restart still knows.
 */
export function directInviteFrom(room: MatrixInvitedRoom, me: MatrixIdentity): string | undefined {
  for (const event of room.invite_state?.events ?? []) {
    if (event.type !== "m.room.member" || event.state_key !== me.userId) continue;
    const content = event.content ?? {};
    if (content.membership !== "invite") continue;
    if (content.is_direct === true) return event.sender;
  }
  return undefined;
}

/**
 * The {@link ChannelMessage} for a timeline event, or `undefined` when
 * there is nothing for a chat pipeline to look at: not an `m.room.message`
 * (a reaction, a membership change, an encrypted event this channel can't
 * decrypt), one with no `msgtype` at all (a redacted message), or an edit of
 * a message that was already delivered (see below).
 */
export function toChannelMessage(
  roomId: string,
  event: MatrixEvent,
  me: MatrixIdentity,
  directRooms: ReadonlySet<string>,
  sentEventIds: ReadonlySet<string>,
  identities: SessionIdentityRegistry = NO_IDENTITIES,
): ChannelMessage | undefined {
  if (event.type !== "m.room.message") return undefined;
  const content = event.content as MatrixMessageContent;
  if (!content.msgtype) return undefined;
  // An edit is a whole new event relating to the original with
  // `rel_type: "m.replace"`, and its `body` is the `* new text` fallback
  // clients render for anything that can't display edits. Treating it as a
  // fresh message means answering the same question twice, the second time
  // with an asterisk glued to the front, so edits are ignored: the bot
  // answers what it was asked, once.
  if (content["m.relates_to"]?.rel_type === "m.replace") return undefined;

  return {
    chatId: roomId,
    senderId: event.sender,
    text: messageText(content),
    isDirectMessage: directRooms.has(roomId),
    mentionsBot: mentionsBot(content, me),
    isReplyToBot: isReplyToBot(content, sentEventIds),
    // One access token is one user, but one process is not: a second bot
    // account mounted alongside this one is a stranger to `me` and would be
    // answered, and would answer back, forever. `identities` is what makes
    // the other endpoint's user id "us" too - an empty one degenerates to
    // the equality check.
    fromBot: isEffectivelyFromSelf(
      { fromBot: event.sender === me.userId, senderId: event.sender },
      identities,
    ),
    messageRef: event.event_id,
  };
}

/**
 * What this bot answers to on the wire, for a {@link SessionIdentityRegistry}.
 * A Matrix user id is already globally unique (`@user:server.tld`), so it
 * needs no namespacing to sit safely beside another transport's identities.
 */
export function matrixOwnIdentities(me: MatrixIdentity): string[] {
  return [me.userId];
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
