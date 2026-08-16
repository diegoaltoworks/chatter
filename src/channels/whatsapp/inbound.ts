/**
 * WhatsApp inbound: turns a raw Baileys message into a reply through
 * chatter's own pipeline (`prepareChat` + `answerOnce`), gated by
 * `./channels`' reply gates and loop guard. `./channel` hands every raw
 * message to `config.onMessage` uninterpreted — this module is that
 * interpretation.
 *
 * Message-shape parsing (text/caption extraction, contextInfo mentions and
 * quoted-reply resolution) is genericized from the reference implementation:
 * text AND contextInfo live in a DIFFERENT place per message shape — plain
 * text carries both on `extendedTextMessage`, but a photo/video/document
 * carries its caption on its own message type and its contextInfo there too.
 * Missing that meant mentions in photo captions were invisible and group
 * photo requests were silently ignored.
 *
 * `createWhatsAppInboundHandler` needs `ServerDependencies`
 * (`client`/`store`/`prompts`), which only exists once `createServer` builds
 * it — after `channels` (and therefore `onMessage`) must already be
 * configured. Wire it up from `ChatterConfig.customRoutes`, which runs
 * before channels start and receives the same deps:
 *
 * ```ts
 * let handleInbound: ((event: WhatsAppMessageEvent) => Promise<void>) | undefined;
 * const whatsapp = createWhatsAppChannel({
 *   sessionSecret: process.env.WA_SESSION_SECRET as string,
 *   onMessage: (event) => handleInbound?.(event),
 * });
 *
 * await createServer({
 *   ...,
 *   channels: [whatsapp],
 *   customRoutes: async (app, deps) => {
 *     handleInbound = createWhatsAppInboundHandler({
 *       client: deps.client,
 *       store: deps.store,
 *       prompts: deps.prompts,
 *       answerFn: deps.config.answerFn,
 *       bucketsFor: deps.config.bucketsFor,
 *       registry: new Map(),
 *     });
 *   },
 * });
 * ```
 */

import type { WAMessage, WASocket } from "@whiskeysockets/baileys";
import type OpenAI from "openai";
import { type AnswerFn, answerOnce } from "../../core/answer";
import { type BucketsFor, resolveBuckets } from "../../core/buckets";
import { prepareChat } from "../../core/pipeline";
import type { PromptLoader } from "../../core/prompts";
import type { VectorStore } from "../../core/retrieval";
import {
  type ChannelMessage,
  createSlidingWindowRateLimiter,
  decideChannelAction,
  isBlockedByAllowlist,
  isEffectivelyFromSelf,
  type SessionIdentityRegistry,
  underReplyRateLimit,
} from "../gates";
import type { WhatsAppMessageEvent } from "./channel";
import type { WhatsAppImageHandler } from "./images";

// --- jid helpers (pure, Baileys-shape only) ---

export function isGroupJid(jid: string): boolean {
  return jid.endsWith("@g.us");
}

/** The user part of a jid, without device suffix or domain: "447700900123:17@s.whatsapp.net" -> "447700900123". */
function bareUser(jid: string): string {
  return jid.split("@")[0]?.split(":")[0] ?? "";
}

/** "447700900123:17@s.whatsapp.net" (device-suffixed) and "447700900123@s.whatsapp.net" match. */
export function jidsMatch(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return bareUser(a) === bareUser(b);
}

export function jidToPhoneNumber(jid: string): string {
  const bare = bareUser(jid);
  return bare.startsWith("+") ? bare : `+${bare}`;
}

/**
 * Strips a jid's device suffix (`":17"`) for identity comparisons, but keeps
 * the domain — unlike {@link jidsMatch}, which is deliberately domain-blind
 * for mention/reply matching. Collapsing `@lid` and `@s.whatsapp.net` into
 * the same key here would let an unrelated LID and phone jid that happen to
 * share a numeral compare equal in the loop-guard registry.
 */
function normalizeJid(jid: string): string {
  const [user = "", domain] = jid.split("@");
  const withoutDevice = user.split(":")[0] ?? user;
  return domain ? `${withoutDevice}@${domain}` : withoutDevice;
}

/**
 * Resolve the sender's real phone number. Modern WhatsApp identifies group
 * senders (and some DM chats) by LID (anonymized `"12345@lid"`), which
 * carries no relationship to the phone number — treating it as one silently
 * keys per-person state on garbage. Prefer the `*Pn` fields Baileys attaches
 * when available, then fall back to the socket's own LID mapping store.
 *
 * The returned string is a stable identity key, not guaranteed to be a
 * dialable phone number: an unresolved LID returns an explicit `"lid:<id>"`
 * marker rather than a phone-shaped fabrication (`jidToPhoneNumber("12345@lid")`
 * would otherwise yield `"+12345"`, indistinguishable from a real number) —
 * callers keying security or spend decisions off `sender` (`bucketsFor`,
 * usage metering) must not mistake a LID numeral for a phone number.
 */
export async function senderPhoneFor(
  sock: WASocket,
  message: WAMessage,
  chatJid: string,
): Promise<string> {
  const key = message.key as {
    participant?: string;
    participantPn?: string;
    senderPn?: string;
    remoteJidAlt?: string;
  };
  // A ?? chain would happily keep an EMPTY STRING Baileys can set on
  // `participant` in LID-addressed DMs — filter empties explicitly.
  let jid =
    [key.participantPn, key.senderPn, key.participant, key.remoteJidAlt, chatJid].find(
      (candidate) => typeof candidate === "string" && candidate.length > 0,
    ) ?? chatJid;
  if (jid.endsWith("@lid")) {
    try {
      const mapped = await (
        sock as unknown as {
          signalRepository?: {
            lidMapping?: { getPNForLID?: (l: string) => Promise<string | null> };
          };
        }
      ).signalRepository?.lidMapping?.getPNForLID?.(jid);
      if (mapped) jid = mapped;
    } catch {
      // fall through with the lid; the branch below returns an explicit
      // lid: marker rather than a fabricated phone number
    }
  }
  return jid.endsWith("@lid")
    ? `lid:${jid.split("@")[0]?.split(":")[0] ?? jid}`
    : jidToPhoneNumber(jid);
}

// --- message-shape helpers (pure, Baileys-shape only) ---

export interface WaMessageContext {
  mentionedJids: string[];
  quotedParticipantJid?: string;
}

/**
 * contextInfo (mentions, quoted message) lives in a DIFFERENT place per
 * message shape: a plain text message carries it on `extendedTextMessage`,
 * but a photo/video/document message carries it on its own type.
 */
export function messageContext(message: WAMessage): WaMessageContext {
  const content = message.message;
  const contextInfo =
    content?.extendedTextMessage?.contextInfo ??
    content?.imageMessage?.contextInfo ??
    content?.videoMessage?.contextInfo ??
    content?.documentMessage?.contextInfo;
  return {
    mentionedJids: contextInfo?.mentionedJid ?? [],
    quotedParticipantJid: contextInfo?.participant ?? undefined,
  };
}

/** Text/caption across every shape that can carry one — plain text, a reply, or a photo/video/document caption. */
export function extractText(message: WAMessage): string {
  const content = message.message;
  if (!content) return "";
  return (
    content.conversation ??
    content.extendedTextMessage?.text ??
    content.imageMessage?.caption ??
    content.videoMessage?.caption ??
    content.documentMessage?.caption ??
    ""
  );
}

/**
 * Removes the bot's OWN @mention tokens from a message's text.
 *
 * WhatsApp puts a mention in the raw text as the literal token `@<digits>` —
 * the mentioned jid's user part — and only resolves it to a jid separately,
 * on `contextInfo.mentionedJid`. Handed to a model untouched, the bot's own
 * mention reads as a meaningless number, and the answer derails into asking
 * the sender what `@<botDigits>` means instead of doing what the rest of the
 * message asked.
 *
 * Only the bot's own tokens go: another participant's mention is real
 * context ("tell @<someoneElse> I'm late"), and the numeral is all the model
 * gets of them. Matching is on the digits alone, so both the phone-number and
 * the LID form of the bot's own identity are covered.
 *
 * Everything else in the message is left byte-for-byte alone — indentation
 * and blank lines in a pasted snippet included.
 *
 * A mention-only message ("@bot" and nothing else) keeps its original text:
 * emptying it would make the reply gates read it as blank and drop it, so the
 * bot would go silent on being addressed rather than answer.
 */
export function stripOwnMentions(text: string, ownIds: string[]): string {
  const ownUsers = new Set(ownIds.map(bareUser).filter(Boolean));
  if (!text || ownUsers.size === 0) return text;

  let struck = false;
  // A token starts a word ("bob@447700900123.com" is an address, not a
  // mention) and takes the horizontal whitespace after it — but never a
  // newline, so a mention on its own line leaves the following lines whole.
  const stripped = text.replace(/(?<!\S)@(\d+)[^\S\n]*/g, (token, digits: string) => {
    if (!ownUsers.has(digits)) return token;
    struck = true;
    return "";
  });
  if (!struck) return text;

  const cleaned = stripped.trim();
  return cleaned ? cleaned : text;
}

// --- inbound handler ---

export interface WhatsAppInboundConfig {
  client: OpenAI;
  store: VectorStore;
  prompts: PromptLoader;
  answerFn?: AnswerFn;
  bucketsFor?: BucketsFor;
  model?: string;
  /**
   * Own identities per session — share ONE registry across every session
   * this process runs so a message from one session's own number never
   * looks like a stranger to another (the loop-guard case a single
   * session's `fromMe` flag can't catch). Kept in sync from every message,
   * not just at connection open, because a session's LID identity can
   * populate late.
   */
  registry: SessionIdentityRegistry;
  /** Group chats eligible for a reply. Empty (default) = every group. Has no effect on DMs, which always reply regardless. */
  allowedChats?: string[];
  muteRegex?: RegExp;
  unmuteRegex?: RegExp;
  /** Neutral, overridable acknowledgements — this module ships no bot personality; unset = silent mute/unmute. */
  muteReply?: string;
  unmuteReply?: string;
  dmRateLimit?: { max: number; windowMs: number };
  groupRateLimit?: { max: number; windowMs: number };
  /** Extra system-prompt section describing the delivery channel; passed through to `prepareChat`. */
  channelHint?: string;
  /**
   * Optional persona layer for a sender/text pair — the resolution
   * mechanism (registry, windowed rolls, prompt files) lives in its own
   * module; this only plugs the result into `prepareChat`'s `personaLayer`.
   * A throw/rejection is treated as "no persona" for that turn.
   */
  personaResolver?: (ctx: {
    senderPhone: string;
    text: string;
  }) => string | undefined | Promise<string | undefined>;
  /**
   * Optional image-request routing (see `./images`). Consulted right before
   * the normal chat pipeline; a `true` result means the message was handled
   * as an image request (successfully or with a mapped error string) and
   * this handler returns without answering through chat. Inert unless
   * `./images` is configured.
   */
  images?: WhatsAppImageHandler;
  now?: () => number;
}

// Defence in depth, not a spend guard: unthrottled DMs let a single sender
// (or a loop) hammer the brain at full speed; these are deliberately
// generous defaults a host is expected to tune.
const DEFAULT_GROUP_RATE_LIMIT = { max: 30, windowMs: 60 * 60 * 1000 };
const DEFAULT_DM_RATE_LIMIT = { max: 20, windowMs: 60 * 60 * 1000 };

/** A throwing/rejecting resolver degrades to "no persona" for this turn rather than failing the whole reply. */
async function resolvePersonaLayer(
  config: WhatsAppInboundConfig,
  ctx: { senderPhone: string; text: string },
): Promise<string | undefined> {
  if (!config.personaResolver) return undefined;
  try {
    return await config.personaResolver(ctx);
  } catch {
    return undefined;
  }
}

/** Builds the `onMessage` handler for `createWhatsAppChannel` (see `./channel`) — see the module docstring for how to wire `ServerDependencies` into it. */
export function createWhatsAppInboundHandler(
  config: WhatsAppInboundConfig,
): (event: WhatsAppMessageEvent) => Promise<void> {
  const mutedChats = new Set<string>();
  // `sessionId:chatId` pairs already logged as blocked by the allowlist — a
  // host only needs to see a rejected group's jid once per session to add
  // it, and a chatty non-allowlisted group re-sending the same rejection
  // every message would otherwise flood the log. Keyed by session too: two
  // linked numbers sharing this handler can each be in the same rejected
  // group, and each session's own log line is what tells its host about it.
  const loggedUnallowedChats = new Set<string>();
  const now = config.now ?? Date.now;
  const group = config.groupRateLimit ?? DEFAULT_GROUP_RATE_LIMIT;
  const dm = config.dmRateLimit ?? DEFAULT_DM_RATE_LIMIT;
  const underGroupRateLimit = createSlidingWindowRateLimiter(group.max, group.windowMs, now);
  const underDmRateLimit = createSlidingWindowRateLimiter(dm.max, dm.windowMs, now);

  return async function handleWhatsAppMessage(event: WhatsAppMessageEvent): Promise<void> {
    const { sessionId, sock, message } = event;
    try {
      const chatId = message.key.remoteJid ?? "";
      if (!chatId || chatId === "status@broadcast") return;

      const rawText = extractText(message);
      const context = messageContext(message);
      const senderId = message.key.participant ?? chatId;

      // Kept in sync on every message, not just at connection open: the
      // socket's LID identity can populate later via creds.update, and the
      // registry must never be staler than this session's own view of
      // itself. Entries are never removed — see SessionIdentityRegistry.
      // Normalized (device suffix stripped): Baileys reports sock.user.id
      // WITH a device suffix ("...:12@domain") while the same number
      // arrives on another session's socket as a bare participant jid —
      // comparing raw strings would never match, defeating the guard in
      // exactly the two-linked-numbers scenario it exists for.
      const ownIds = [sock.user?.id, (sock.user as { lid?: string } | undefined)?.lid]
        .filter((id): id is string => Boolean(id))
        .map(normalizeJid);
      config.registry.set(sessionId, ownIds);

      // Everything downstream — gates, image routing, persona resolution, the
      // model itself — works on the text a human would read, with the bot's
      // own mention token removed. That includes the mute/unmute patterns: a
      // host's anchored regex sees "shut up", not "@<botDigits> shut up",
      // which is what an addressed command actually looks like to a reader.
      // A non-empty message never strips to empty (see stripOwnMentions), so
      // nothing newly falls through the gates' blank-text check.
      const text = stripOwnMentions(rawText, ownIds);

      const fromBot = isEffectivelyFromSelf(
        { fromBot: message.key.fromMe ?? false, senderId: normalizeJid(senderId) },
        config.registry,
      );

      const msg: ChannelMessage = {
        chatId,
        senderId,
        text,
        isDirectMessage: !isGroupJid(chatId),
        mentionsBot: context.mentionedJids.some((jid) => ownIds.some((own) => jidsMatch(jid, own))),
        isReplyToBot: ownIds.some((own) => jidsMatch(context.quotedParticipantJid, own)),
        fromBot,
      };

      const allowedChats = config.allowedChats ?? [];
      const action = decideChannelAction(msg, {
        allowedChats,
        mutedChats,
        muteRegex: config.muteRegex,
        unmuteRegex: config.unmuteRegex,
      });

      if (action === "mute") {
        mutedChats.add(chatId);
        if (config.muteReply) await sock.sendMessage(chatId, { text: config.muteReply });
        return;
      }
      if (action === "unmute") {
        mutedChats.delete(chatId);
        if (config.unmuteReply) await sock.sendMessage(chatId, { text: config.unmuteReply });
        return;
      }
      if (action === "ignore" && isBlockedByAllowlist(msg, { allowedChats })) {
        const dedupKey = `${sessionId}:${chatId}`;
        if (!loggedUnallowedChats.has(dedupKey)) {
          loggedUnallowedChats.add(dedupKey);
          console.log(`WhatsApp[${sessionId}]: skipped group ${chatId} - not in allowedChats`);
        }
      }
      if (action !== "reply") return;

      if (!underReplyRateLimit(msg, { dm: underDmRateLimit, group: underGroupRateLimit })) {
        return;
      }

      const senderPhone = await senderPhoneFor(sock, message, chatId);

      if (config.images) {
        const handled = await config.images({
          sock,
          message,
          chatId,
          senderId: senderPhone,
          text,
          hasPhoto: Boolean(message.message?.imageMessage),
        });
        if (handled) return;
      }

      const personaLayer = await resolvePersonaLayer(config, { senderPhone, text });
      const buckets = await resolveBuckets({
        mode: "public",
        sender: senderPhone,
        bucketsFor: config.bucketsFor,
      });

      const messages = [{ role: "user" as const, content: text }];
      const { system } = await prepareChat({
        store: config.store,
        prompts: config.prompts,
        mode: "public",
        messages,
        personaLayer,
        channelHint: config.channelHint,
        buckets,
      });

      const { content } = await answerOnce({
        answerFn: config.answerFn,
        client: config.client,
        system,
        messages,
        mode: "public",
        sender: senderPhone,
        conversationId: chatId,
        model: config.model,
      });

      if (content) {
        await sock.sendMessage(chatId, { text: content }, { quoted: message });
      }
    } catch (error) {
      console.warn(`WhatsApp[${sessionId}]: inbound message handling failed:`, error);
    }
  };
}
