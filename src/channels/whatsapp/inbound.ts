/**
 * WhatsApp inbound: turns a raw Baileys message into a reply through
 * chatter's own pipeline (`prepareChat` + `answerOnce`), gated by
 * `./channels`' reply gates and loop guard. `./channel` hands every raw
 * message to `config.onMessage` uninterpreted — this module is that
 * interpretation.
 *
 * Message-shape parsing (text/caption extraction, contextInfo mentions and
 * quoted-reply resolution) accounts for a Baileys quirk: text AND contextInfo
 * live in a DIFFERENT place per message shape - plain text carries both on
 * `extendedTextMessage`, but a photo/video/document carries its caption on
 * its own message type and its contextInfo there too. Missing that meant
 * mentions in photo captions were invisible and group photo requests were
 * silently ignored.
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
 *       // Falls back to deps.config.{answerFn,bucketsFor,rewriteQuery,
 *       // rerankContext,fallbackFn,transformReply} for whichever of those
 *       // this config doesn't set itself.
 *       serverConfig: deps.config,
 *       registry: new Map(),
 *       logger: deps.logger,
 *     });
 *   },
 * });
 * ```
 */

import type { WAMessage, WASocket } from "@whiskeysockets/baileys";
import type OpenAI from "openai";
import { createConsoleLogger, type Logger } from "../../core/logger";
import type { PromptLoader } from "../../core/prompts";
import type { Retriever } from "../../core/retrieval";
import type { HistoryCompactionOptions } from "../../history/compaction";
import type { HistoryStore } from "../../history/types";
import type { BrainHooks } from "../../types";
import {
  type ChannelMessage,
  isBlockedByAllowlist,
  isEffectivelyFromSelf,
  type SessionIdentityRegistry,
} from "../gates";
import { createInboundPipeline, type InboundReplySender, resolveBrainHooks } from "../pipeline";
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

export interface ResolvedWaMessage {
  msg: ChannelMessage;
  /** This session's own identities (phone + LID, normalized), as just written to `registry`. */
  ownIds: string[];
}

/**
 * Turns a raw Baileys message into the {@link ChannelMessage} shape every
 * consumer works from — own-identity resolution, the loop guard, and
 * mention/reply-to detection — done ONCE per message. `createWhatsAppInboundHandler`
 * and `./router`'s `createWhatsAppMessageRouter` both call this rather than
 * each re-deriving it, so registering more detectors on the router never
 * multiplies this work.
 */
export function resolveWaMessage(
  event: WhatsAppMessageEvent,
  registry: SessionIdentityRegistry,
): ResolvedWaMessage {
  const { sessionId, sock, message, endpointId } = event;
  const chatId = message.key.remoteJid ?? "";
  const rawText = extractText(message);
  const context = messageContext(message);
  const senderId = message.key.participant ?? chatId;

  // Kept in sync on every message, not just at connection open: the socket's
  // LID identity can populate later via creds.update, and the registry must
  // never be staler than this session's own view of itself. Entries are
  // never removed — see SessionIdentityRegistry. Normalized (device suffix
  // stripped): Baileys reports sock.user.id WITH a device suffix
  // ("...:12@domain") while the same number arrives on another session's
  // socket as a bare participant jid — comparing raw strings would never
  // match, defeating the guard in exactly the two-linked-numbers scenario it
  // exists for.
  const ownIds = [sock.user?.id, (sock.user as { lid?: string } | undefined)?.lid]
    .filter((id): id is string => Boolean(id))
    .map(normalizeJid);
  registry.set(sessionId, ownIds);

  // Everything downstream — gates, image routing, persona resolution, the
  // model itself — works on the text a human would read, with the bot's own
  // mention token removed.
  const text = stripOwnMentions(rawText, ownIds);

  const fromBot = isEffectivelyFromSelf(
    { fromBot: message.key.fromMe ?? false, senderId: normalizeJid(senderId) },
    registry,
  );

  const msg: ChannelMessage = {
    chatId,
    senderId,
    text,
    isDirectMessage: !isGroupJid(chatId),
    mentionsBot: context.mentionedJids.some((jid) => ownIds.some((own) => jidsMatch(jid, own))),
    isReplyToBot: ownIds.some((own) => jidsMatch(context.quotedParticipantJid, own)),
    fromBot,
    // The Baileys message key — what `sendMessage(chatId, { react: { key, text } })`
    // targets. Exposed generically so a caller reaching `msg` through
    // `createInboundPipeline` (not just the WhatsApp-specific router) can
    // still react to it via `ChannelSenderRegistry.sendReaction`.
    messageRef: message.key,
    // The session id this channel instance was configured with, not a wire
    // identity - stable across the number's own SIM or token changing.
    // Unset for a default single-session channel (see
    // WhatsAppMessageEvent.endpointId) so a host that hasn't opted into
    // multiple endpoints sees no change.
    endpointId,
  };

  return { msg, ownIds };
}

// --- inbound handler ---

export interface WhatsAppInboundConfig extends BrainHooks {
  client: OpenAI;
  store: Retriever;
  prompts: PromptLoader;
  /**
   * Fallback source for the brain hooks above, each consulted only when this
   * config's own field is unset. Pass `deps.config` from the `customRoutes`
   * callback (see the module docstring) so this handler automatically
   * honours a server-level hook, the same precedence `./telegram` and
   * `./matrix` apply internally via `resolveBrainHooks`. Unset: only this
   * config's own fields count.
   */
  serverConfig?: BrainHooks;
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
  /**
   * Optional conversation history (see `./history`). Off by default —
   * WhatsApp stays single-turn, unchanged, until a store is configured. When
   * set, prior turns for the chat are loaded before answering and the new
   * turn (user message, then reply) is appended after.
   */
  history?: {
    store: HistoryStore;
    /** Most recent turns to load per reply. @default 20 */
    limit?: number;
    /**
     * Excludes a sender from history entirely — see
     * `InboundPipelineConfig.history.historyEnabledFor` in `./channels`.
     * @default every sender is enabled
     */
    historyEnabledFor?: (sender: string) => boolean | Promise<boolean>;
    /**
     * Summarize-then-truncate compaction — see
     * `InboundPipelineConfig.history.compaction` in `./channels`.
     * @default off
     */
    compaction?: HistoryCompactionOptions;
  };
  now?: () => number;
  /** Logger for gate/dispatch diagnostics. Default: a console logger writing to stderr. */
  logger?: Logger;
}

/** Builds the `onMessage` handler for `createWhatsAppChannel` (see `./channel`) — see the module docstring for how to wire `ServerDependencies` into it. Everything past turning a raw Baileys message into a `ChannelMessage` runs through `./channels`' `createInboundPipeline`, shared with every other channel. */
export function createWhatsAppInboundHandler(
  config: WhatsAppInboundConfig,
): (event: WhatsAppMessageEvent) => Promise<void> {
  // `sessionId:chatId` pairs already logged as blocked by the allowlist — a
  // host only needs to see a rejected group's jid once per session to add
  // it, and a chatty non-allowlisted group re-sending the same rejection
  // every message would otherwise flood the log. Keyed by session too: two
  // linked numbers sharing this handler can each be in the same rejected
  // group, and each session's own log line is what tells its host about it.
  const loggedUnallowedChats = new Set<string>();

  // Read once, here, rather than off `config` on every message: the
  // pipeline below closes over its own config snapshot at this same point,
  // so reading `config.allowedChats`/`personaResolver`/`images` live later
  // would silently disagree with what the pipeline actually gates on if a
  // caller mutated `config` after construction.
  const allowedChats = config.allowedChats ?? [];
  const personaResolver = config.personaResolver;
  const images = config.images;
  const logger = config.logger ?? createConsoleLogger();

  const pipeline = createInboundPipeline(
    { client: config.client, store: config.store, prompts: config.prompts },
    {
      channel: "whatsapp",
      ...resolveBrainHooks(config, config.serverConfig),
      model: config.model,
      channelHint: config.channelHint ?? "Channel: WhatsApp.",
      personaResolver: personaResolver
        ? ({ sender, text }) => personaResolver({ senderPhone: sender, text })
        : undefined,
      history: config.history,
      allowedChats,
      muteRegex: config.muteRegex,
      unmuteRegex: config.unmuteRegex,
      muteReply: config.muteReply,
      unmuteReply: config.unmuteReply,
      dmRateLimit: config.dmRateLimit,
      groupRateLimit: config.groupRateLimit,
      now: config.now,
      logger,
    },
  );

  return async function handleWhatsAppMessage(event: WhatsAppMessageEvent): Promise<void> {
    const { sessionId, sock, message } = event;
    try {
      const chatId = message.key.remoteJid ?? "";
      if (!chatId || chatId === "status@broadcast") return;

      // Mute/unmute patterns and the model both see the text a human would
      // read: a host's anchored regex sees "shut up", not "@<botDigits> shut
      // up", which is what an addressed command actually looks like to a
      // reader (see stripOwnMentions, applied inside resolveWaMessage).
      const { msg } = resolveWaMessage(event, config.registry);
      const text = msg.text;

      // Logged independently of the pipeline's own decision-making — a
      // group jid isn't guessable in advance, and this is the one gate
      // outcome worth a host seeing without instrumenting every drop.
      if (isBlockedByAllowlist(msg, { allowedChats })) {
        const dedupKey = `${sessionId}:${chatId}`;
        if (!loggedUnallowedChats.has(dedupKey)) {
          loggedUnallowedChats.add(dedupKey);
          logger.warn(`WhatsApp[${sessionId}]: skipped group ${chatId} - not in allowedChats`);
        }
      }

      const reply: InboundReplySender = {
        sendAnswer: async (targetChatId, replyText) => {
          await sock.sendMessage(targetChatId, { text: replyText }, { quoted: message });
        },
        sendGateReply: async (targetChatId, replyText) => {
          await sock.sendMessage(targetChatId, { text: replyText });
        },
      };

      await pipeline(msg, {
        reply,
        conversationId: chatId,
        sender: () => senderPhoneFor(sock, message, chatId),
        intercept: images
          ? (senderPhone) =>
              images({
                sock,
                message,
                chatId,
                senderId: senderPhone,
                text,
                hasPhoto: Boolean(message.message?.imageMessage),
              })
          : undefined,
      });
    } catch (error) {
      logger.warn(`WhatsApp[${sessionId}]: inbound message handling failed:`, error);
    }
  };
}
