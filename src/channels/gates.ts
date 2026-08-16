/**
 * Channel-agnostic reply gates — pure and testable, zero imports from the
 * rest of chatter. A transport (WhatsApp, or any future channel) resolves
 * its own wire format into a {@link ChannelMessage} and calls
 * {@link decideChannelAction} to learn whether to answer, stay quiet, or
 * flip a mute switch. Nothing here knows about jids, Baileys, or any
 * specific bot's name — mention/reply-to detection is the transport's job;
 * this module only combines the already-resolved booleans with allowlist,
 * mute, and rate-limit policy.
 */

/** The slice of an inbound message every channel can resolve into this shape. */
export interface ChannelMessage {
  /** The conversation this message belongs to — a DM thread or a group. */
  chatId: string;
  senderId: string;
  text: string;
  /** True for a 1:1 conversation; false for a group/channel with other members. */
  isDirectMessage: boolean;
  /** Resolved by the caller: does this message @-mention the bot? */
  mentionsBot: boolean;
  /** Resolved by the caller: is this message a reply to one of the bot's own messages? */
  isReplyToBot: boolean;
  /** True when the bot itself sent this message (including via another session — see {@link isEffectivelyFromSelf}). */
  fromBot: boolean;
  /**
   * Opaque, transport-defined handle for targeting this specific message —
   * e.g. `ChannelSenderRegistry.sendReaction`'s `messageRef` — not
   * interpreted by anything in this module. Omitted transports (or
   * messages a transport can't target individually) simply have none.
   */
  messageRef?: unknown;
}

export type ChannelAction = "reply" | "ignore" | "mute" | "unmute";

export interface ChannelGateConfig {
  /** Chats eligible for a reply. Empty = every chat is eligible (the master allowlist switch). */
  allowedChats: string[];
  /** Group chats currently muted — addressed messages there are ignored until unmuted. Has no effect on DMs, which always reply. */
  mutedChats: Set<string>;
  /**
   * Caller-supplied trigger for "go quiet in this group chat". No default:
   * this module ships no bot name or in-character phrasing, so mute/unmute
   * are inert unless a host configures a pattern. Never applied to DMs.
   */
  muteRegex?: RegExp;
  unmuteRegex?: RegExp;
}

/** Tests `text` against `re` without `re`'s `lastIndex` carrying state between calls on a `g`/`y` regex the caller reuses across messages. */
function matches(re: RegExp, text: string): boolean {
  return new RegExp(re.source, re.flags.replace(/[gy]/g, "")).test(text);
}

/**
 * True when `msg` is dropped because its chat isn't on `allowedChats`. The
 * allowlist is the first group-only check {@link decideChannelAction} makes,
 * before mute/unmute and addressing, so whenever this is true the allowlist
 * really is the attributable reason for the "ignore" — a transport can log
 * just this case without misattributing a drop that happened for a different
 * cause (from the bot itself, blank text, muted, unaddressed).
 */
export function isBlockedByAllowlist(
  msg: ChannelMessage,
  config: Pick<ChannelGateConfig, "allowedChats">,
): boolean {
  return (
    !msg.fromBot &&
    msg.text.trim().length > 0 &&
    !msg.isDirectMessage &&
    config.allowedChats.length > 0 &&
    !config.allowedChats.includes(msg.chatId)
  );
}

/**
 * DMs always reply. In groups, only an allowlisted, unmuted chat gets a
 * reply, and only when addressed (mentioned or replying to the bot) —
 * merely mentioning the bot's name in third person is not an invitation.
 * The unmute check runs before the muted-chat gate so an unmute phrase can
 * un-silence the bot in the same message, and both run after the allowlist
 * so a chat the bot isn't eligible for can't toggle its mute state.
 */
export function decideChannelAction(msg: ChannelMessage, config: ChannelGateConfig): ChannelAction {
  if (msg.fromBot || !msg.text.trim()) return "ignore";
  if (!msg.isDirectMessage) {
    if (isBlockedByAllowlist(msg, config)) return "ignore";
    if (config.muteRegex && matches(config.muteRegex, msg.text)) return "mute";
    if (config.unmuteRegex && matches(config.unmuteRegex, msg.text)) return "unmute";
    if (config.mutedChats.has(msg.chatId)) return "ignore";
    return msg.mentionsBot || msg.isReplyToBot ? "reply" : "ignore";
  }
  return "reply";
}

/**
 * Sliding-window rate limiter (pure, injectable clock): true = allowed and
 * counted. One instance guards one budget — callers wanting separate DM and
 * group budgets create two (see {@link underReplyRateLimit}).
 *
 * Keyed by chatId, which — unlike an IP — a caller can't rotate at will, but
 * a long-lived deployment still accumulates one entry per chat it has ever
 * seen, including chats that never come back. A global sweep (same shape as
 * `windowBucket.ts`'s) runs at most once per window, on a call for any key,
 * and drops every key whose entries have all fallen out of the window —
 * bounding the map to chats active within roughly the last two windows
 * instead of growing for the life of the process. `allow.size()` reports
 * the current key count, for tests asserting eviction actually happened.
 *
 * @internal `size` is an observability hook for this module's own tests, not
 * part of the public contract — callers should treat the return value as a
 * plain `(key: string) => boolean`.
 */
export function createSlidingWindowRateLimiter(
  maxPerWindow: number,
  windowMs: number,
  now: () => number = Date.now,
) {
  const log = new Map<string, number[]>();
  let lastSweep = now();

  function sweep(current: number) {
    if (current - lastSweep < windowMs) return;
    lastSweep = current;
    const cutoff = current - windowMs;
    for (const [key, entries] of log) {
      if (!entries.some((t) => t > cutoff)) log.delete(key);
    }
  }

  function allow(key: string): boolean {
    const current = now();
    sweep(current);
    const cutoff = current - windowMs;
    const entries = (log.get(key) ?? []).filter((t) => t > cutoff);
    if (entries.length >= maxPerWindow) {
      if (entries.length > 0) log.set(key, entries);
      else log.delete(key);
      return false;
    }
    entries.push(current);
    log.set(key, entries);
    return true;
  }

  allow.size = () => log.size;
  return allow;
}

/**
 * Routes a chat to its DM or group rate limiter so a flood in one can't
 * spend the other's budget — a DM flood used to be entirely unthrottled
 * before this split existed. Each limiter is expected to be its own
 * {@link createSlidingWindowRateLimiter} instance.
 */
export function underReplyRateLimit(
  msg: Pick<ChannelMessage, "chatId" | "isDirectMessage">,
  limiters: { dm: (chatId: string) => boolean; group: (chatId: string) => boolean },
): boolean {
  return msg.isDirectMessage ? limiters.dm(msg.chatId) : limiters.group(msg.chatId);
}

/**
 * Every session's own identities ever seen, keyed by session id.
 *
 * The failure this exists to prevent: link two numbers to one process (a
 * common WhatsApp setup — a "support" and a "sales" line sharing a server),
 * and each session's transport only tells that session its own identity. A
 * message from the OTHER linked number's session then looks like a
 * stranger, not "us" — the bot answers it, the other session sees THAT
 * reply as a new stranger message and answers it back, and the two numbers
 * ping-pong replies at each other indefinitely, burning the rate limit and
 * spamming both chats until someone notices and kills the process. Sharing
 * one registry across every session (rather than each session checking only
 * its own identity) is what lets session A recognise session B's identity
 * as "us" too, and stop the loop before it starts. Callers populate this
 * directly (`registry.set(sessionId, ids)`) as each session's identities
 * become known, typically on connect and kept in sync as they change.
 *
 * Entries are NOT expected to be removed when a session disconnects: a
 * session's own identity is still "us" while it reconnects, and losing that
 * during exactly the disconnect/reconnect window this guard exists for
 * would defeat it.
 */
export type SessionIdentityRegistry = Map<string, string[]>;

/** True when `id` matches an identity of ANY session ever registered, not just the one that received the message. */
export function isFromAnySession(
  id: string | undefined,
  registry: SessionIdentityRegistry,
): boolean {
  if (!id) return false;
  for (const ids of registry.values()) {
    if (ids.includes(id)) return true;
  }
  return false;
}

/**
 * The one predicate transports need before deciding fromBot: a message is
 * effectively from the bot itself if the transport already flagged it so,
 * or if its sender id matches an identity registered by any session (the
 * loop-guard case a single session's own flag can't catch).
 */
export function isEffectivelyFromSelf(
  msg: Pick<ChannelMessage, "fromBot" | "senderId">,
  registry: SessionIdentityRegistry,
): boolean {
  return msg.fromBot || isFromAnySession(msg.senderId, registry);
}
