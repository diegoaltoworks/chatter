/**
 * Channel-agnostic inbound turn — the part of a channel's message handling
 * that has nothing to do with its wire format.
 *
 * A transport (WhatsApp, or any future channel) still owns everything about
 * its own shape: parsing mentions, resolving a sender's real identity,
 * loop-guarding its own traffic, and any transport-specific short-circuit
 * (an image request, a slash command). Once that work has produced a
 * {@link ChannelMessage}, though, every channel needs the exact same next
 * steps — decide reply/ignore/mute/unmute, rate-limit, resolve a persona and
 * retrieval buckets, load/append conversation history, answer through
 * `prepareChat`/`answerOnce`, and deliver the result — and this is that,
 * extracted once so a second channel (Telegram, SMS, ...) never has to
 * re-derive it. See docs/build-a-channel.md for a worked example.
 */

import type OpenAI from "openai";
import type { AnswerFn, TransformReply } from "../core/answer";
import { answerOnce, applyTransformReply } from "../core/answer";
import type { BucketsFor } from "../core/buckets";
import { resolveBuckets } from "../core/buckets";
import type { Logger } from "../core/logger";
import {
  type PipelineMessage,
  type PipelineMode,
  prepareChat,
  type RerankContext,
  type RewriteQuery,
} from "../core/pipeline";
import type { PromptLoader } from "../core/prompts";
import type { VectorStore } from "../core/retrieval";
import type { HistoryStore } from "../history/types";
import {
  type ChannelMessage,
  createSlidingWindowRateLimiter,
  decideChannelAction,
  underReplyRateLimit,
} from "./gates";

/** Where a pipeline turn's output goes. Distinct from `ChannelSender` (`./senders`) — a transport implementing this may thread/quote the chat answer without doing the same for a plain gate acknowledgement. */
export interface InboundReplySender {
  /** Deliver the chat answer for `chatId`. */
  sendAnswer(chatId: string, text: string): Promise<void>;
  /** Deliver a mute/unmute acknowledgement for `chatId` — never the chat answer. */
  sendGateReply(chatId: string, text: string): Promise<void>;
}

export interface InboundPipelineDeps {
  client: OpenAI;
  store: VectorStore;
  prompts: PromptLoader;
}

export interface InboundPipelineConfig {
  /**
   * This channel's identity for `transformReply` — e.g. "whatsapp",
   * "telegram". @default "channel"
   */
  channel?: string;
  answerFn?: AnswerFn;
  bucketsFor?: BucketsFor;
  /** Rewrites the retrieval query before it reaches the vector store — see `ChatterConfig.rewriteQuery`. */
  rewriteQuery?: RewriteQuery;
  /** Post-processes retrieved chunks before they're folded into the prompt — see `ChatterConfig.rerankContext`. */
  rerankContext?: RerankContext;
  /** Modifies or vetoes the produced reply before delivery — see `ChatterConfig.transformReply`. */
  transformReply?: TransformReply;
  model?: string;
  /** Extra system-prompt section describing the delivery channel; passed through to `prepareChat`. */
  channelHint?: string;
  /** A throw/rejection is treated as "no persona" for that turn rather than failing the whole reply. */
  personaResolver?: (ctx: {
    sender: string;
    text: string;
  }) => string | undefined | Promise<string | undefined>;
  /** Off by default — a channel stays single-turn until a store is configured. */
  history?: {
    store: HistoryStore;
    /** Most recent turns to load per reply. @default 20 */
    limit?: number;
    /**
     * Excludes a sender from history entirely — checked before both `load`
     * and `append`, so an opted-out sender's turns are never read back and
     * never written. A throw/rejection fails closed ("not enabled"): a
     * broken predicate must never start recording a sender who may have
     * opted out. @default every sender is enabled
     */
    historyEnabledFor?: (sender: string) => boolean | Promise<boolean>;
  };
  /** Group chats eligible for a reply. Empty (default) = every group. Has no effect on DMs, which always reply. */
  allowedChats?: string[];
  muteRegex?: RegExp;
  unmuteRegex?: RegExp;
  /** Neutral, overridable acknowledgements — this module ships no bot personality; unset = silent mute/unmute. */
  muteReply?: string;
  unmuteReply?: string;
  dmRateLimit?: { max: number; windowMs: number };
  groupRateLimit?: { max: number; windowMs: number };
  now?: () => number;
  /** Logs a `transformReply` throw; the original reply still sends. */
  logger?: Logger;
}

export interface InboundTurn {
  /** Delivers this turn's gate ack / chat answer — see {@link InboundReplySender}. */
  reply: InboundReplySender;
  /**
   * Identity handed to `bucketsFor`/`personaResolver`/`answerFn` — a
   * transport's resolved sender (e.g. a phone number), which may differ
   * from `ChannelMessage.senderId`'s raw wire identity. Accepted as a thunk
   * so a costly resolution only runs once gates and rate-limiting pass.
   * Omitted -> `msg.senderId`.
   */
  sender?: string | (() => string | Promise<string>);
  /** Thread key for history/`answerFn`. Omitted -> `msg.chatId`. */
  conversationId?: string;
  /**
   * Consulted after gates and rate-limiting pass, before persona/buckets/
   * history/answer run — a transport-specific feature (WhatsApp's
   * image-request routing, say) that fully owns the reply for messages it
   * claims. `true` stops the turn here; `false`/`undefined` falls through to
   * the normal chat turn.
   */
  intercept?: (sender: string) => boolean | undefined | Promise<boolean | undefined>;
}

export type InboundPipelineOutcome =
  | { action: "ignore" | "mute" | "unmute" | "rate-limited" | "intercepted" }
  | { action: "reply"; content: string };

/** The reusable handler `createInboundPipeline` returns — one call per inbound message. */
export type InboundPipeline = (
  msg: ChannelMessage,
  turn: InboundTurn,
) => Promise<InboundPipelineOutcome>;

const DEFAULT_HISTORY_LIMIT = 20;

// Defence in depth, not a spend guard: unthrottled DMs let a single sender
// (or a loop) hammer the brain at full speed; these are deliberately
// generous defaults a host is expected to tune.
const DEFAULT_GROUP_RATE_LIMIT = { max: 30, windowMs: 60 * 60 * 1000 };
const DEFAULT_DM_RATE_LIMIT = { max: 20, windowMs: 60 * 60 * 1000 };

async function resolvePersonaLayer(
  config: InboundPipelineConfig,
  ctx: { sender: string; text: string },
): Promise<string | undefined> {
  if (!config.personaResolver) return undefined;
  try {
    return await config.personaResolver(ctx);
  } catch {
    return undefined;
  }
}

async function isHistoryEnabled(config: InboundPipelineConfig, sender: string): Promise<boolean> {
  const predicate = config.history?.historyEnabledFor;
  if (!predicate) return true;
  try {
    return await predicate(sender);
  } catch (error) {
    config.logger?.error("historyEnabledFor threw; disabling history for this turn", error);
    return false;
  }
}

/**
 * Builds the reusable per-session (or per-channel) inbound handler: gates
 * and rate limiters live in its closure, exactly like a hand-rolled
 * transport handler's, so a channel can create one pipeline and feed it
 * every message it receives.
 */
export function createInboundPipeline(
  deps: InboundPipelineDeps,
  config: InboundPipelineConfig,
): InboundPipeline {
  const mutedChats = new Set<string>();
  const now = config.now ?? Date.now;
  const group = config.groupRateLimit ?? DEFAULT_GROUP_RATE_LIMIT;
  const dm = config.dmRateLimit ?? DEFAULT_DM_RATE_LIMIT;
  const underGroupRateLimit = createSlidingWindowRateLimiter(group.max, group.windowMs, now);
  const underDmRateLimit = createSlidingWindowRateLimiter(dm.max, dm.windowMs, now);
  // Every built-in channel answers through the public pipeline; private mode
  // (which widens retrieval and swaps the persona) isn't a knob any channel
  // needs yet, so it stays out of the config surface until one does.
  const mode: PipelineMode = "public";

  return async function handleInboundMessage(msg, turn) {
    const allowedChats = config.allowedChats ?? [];
    const action = decideChannelAction(msg, {
      allowedChats,
      mutedChats,
      muteRegex: config.muteRegex,
      unmuteRegex: config.unmuteRegex,
    });

    if (action === "mute") {
      mutedChats.add(msg.chatId);
      if (config.muteReply) await turn.reply.sendGateReply(msg.chatId, config.muteReply);
      return { action: "mute" };
    }
    if (action === "unmute") {
      mutedChats.delete(msg.chatId);
      if (config.unmuteReply) await turn.reply.sendGateReply(msg.chatId, config.unmuteReply);
      return { action: "unmute" };
    }
    if (action === "ignore") {
      return { action: "ignore" };
    }

    if (!underReplyRateLimit(msg, { dm: underDmRateLimit, group: underGroupRateLimit })) {
      return { action: "rate-limited" };
    }

    const sender =
      typeof turn.sender === "function" ? await turn.sender() : (turn.sender ?? msg.senderId);
    const conversationId = turn.conversationId ?? msg.chatId;

    if (turn.intercept && (await turn.intercept(sender))) {
      return { action: "intercepted" };
    }

    const personaLayer = await resolvePersonaLayer(config, { sender, text: msg.text });
    const buckets = await resolveBuckets({ mode, sender, bucketsFor: config.bucketsFor });

    const historyEnabled = config.history ? await isHistoryEnabled(config, sender) : false;

    const priorTurns =
      config.history && historyEnabled
        ? await config.history.store.load(
            conversationId,
            config.history.limit ?? DEFAULT_HISTORY_LIMIT,
          )
        : [];
    const messages: PipelineMessage[] = [...priorTurns, { role: "user", content: msg.text }];
    // Appended right after the load/messages snapshot, not after the reply:
    // the window between another instance's load for this chat and this
    // turn landing in the store is as narrow as it can be without a
    // transactional read-modify-write.
    if (historyEnabled) {
      await config.history?.store.append(conversationId, { role: "user", content: msg.text });
    }

    const { system } = await prepareChat({
      store: deps.store,
      prompts: deps.prompts,
      mode,
      messages,
      personaLayer,
      channelHint: config.channelHint,
      buckets,
      sender,
      rewriteQuery: config.rewriteQuery,
      rerankContext: config.rerankContext,
      logger: config.logger,
    });

    const { content: produced } = await answerOnce({
      answerFn: config.answerFn,
      client: deps.client,
      system,
      messages,
      mode,
      sender,
      conversationId,
      model: config.model,
    });

    const content = await applyTransformReply(
      config.transformReply,
      { channel: config.channel ?? "channel", sender, conversationId, text: produced },
      config.logger,
    );

    // Recorded as soon as each turn exists, not after delivery: a delivery
    // failure below must not erase the model's answer from history, and a
    // load/append race with a concurrent message for the same chat is
    // narrower the sooner the user's own turn lands.
    if (!content) {
      // Nothing was delivered — an empty answer (or a `transformReply` veto)
      // must not report `reply`, the one outcome a caller relies on to mean
      // "something was sent".
      return { action: "ignore" };
    }
    if (historyEnabled) {
      await config.history?.store.append(conversationId, { role: "assistant", content });
    }
    await turn.reply.sendAnswer(msg.chatId, content);

    return { action: "reply", content };
  };
}
