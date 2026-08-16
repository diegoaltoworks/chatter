/**
 * Brain hook — the seam where a consumer replaces the completion call.
 *
 * Every chat surface (widget routes, OpenAI-compatible routes, channels,
 * programmatic use) asks for an answer through `answerOnce`/`answerStream`
 * instead of calling `completeOnce`/`completeStream` directly. When
 * `ChatterConfig.answerFn` is set it produces the answer — an agent
 * framework, a graph runtime, a remote service, anything — and Chatter keeps
 * owning the rest: retrieval and prompt assembly upstream, auth, rate
 * limiting, transports and output guardrails around it.
 *
 * With no `answerFn` configured these are thin pass-throughs, so behaviour is
 * exactly what it has always been.
 */

import type OpenAI from "openai";
import { guardOutput } from "./guardrails";
import { completeOnce, completeStream } from "./llm";
import type { Logger } from "./logger";
import type { PipelineMessage, PipelineMode } from "./pipeline";

/** Token accounting in the OpenAI wire shape */
export interface AnswerUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/** A brain that reports no token usage still gets a fresh, safely mutable zero */
const noUsage = (): AnswerUsage => ({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });

/** What a brain is given: the assembled prompt plus who is asking */
export interface AnswerFnInput {
  /** Fully assembled system prompt from `prepareChat` */
  system: string;
  /** Conversation messages */
  messages: PipelineMessage[];
  /** Which pipeline the answer is for */
  mode: PipelineMode;
  /** Channel-specific sender identity, when the surface knows one */
  sender?: string;
  /** Stable conversation/thread identifier, when the surface has or generates one */
  conversationId?: string;
}

/**
 * What a brain returns: the answer text, optionally with token usage for
 * surfaces that report it.
 */
export type AnswerFnResult = string | { content: string; usage?: AnswerUsage };

/**
 * Replaces the completion call on every chat surface. Rejections propagate to
 * the caller like any other completion failure.
 */
export type AnswerFn = (input: AnswerFnInput) => Promise<AnswerFnResult> | AnswerFnResult;

export interface AnswerOptions {
  /** Caller-supplied brain; falls back to the built-in completion when unset */
  answerFn?: AnswerFn;
  /** Used by the built-in completion; untouched when `answerFn` answers */
  client: OpenAI;
  system: string;
  messages: PipelineMessage[];
  mode: PipelineMode;
  sender?: string;
  conversationId?: string;
  temperature?: number;
  model?: string;
}

/**
 * Run a brain and normalize what it gives back. The result crosses a plugin
 * boundary, so a missing or non-string answer becomes an empty one rather than
 * a type error deep in a transport; guardrails then apply exactly as they do
 * to a built-in completion.
 */
async function runAnswerFn(
  answerFn: AnswerFn,
  { system, messages, mode, sender, conversationId }: AnswerFnInput,
): Promise<{ content: string; usage: AnswerUsage }> {
  const result = await answerFn({ system, messages, mode, sender, conversationId });
  const raw = typeof result === "string" ? result : result?.content;
  const usage = typeof result === "string" ? undefined : result?.usage;
  return {
    content: guardOutput(typeof raw === "string" ? raw : ""),
    usage: usage ?? noUsage(),
  };
}

/**
 * Produce one complete answer, from `answerFn` when configured.
 */
export async function answerOnce({
  answerFn,
  client,
  system,
  messages,
  mode,
  sender,
  conversationId,
  temperature,
  model,
}: AnswerOptions): Promise<{ content: string; usage: AnswerUsage }> {
  if (answerFn) {
    return runAnswerFn(answerFn, { system, messages, mode, sender, conversationId });
  }
  return completeOnce({ client, system, messages, temperature, model });
}

/** What a `transformReply` hook receives: the produced answer plus who/where it's going. */
export interface TransformReplyInput {
  /**
   * Identifies the surface delivering this reply — a channel's own name
   * (e.g. "whatsapp", "telegram") or a fixed identifier for an HTTP surface
   * (e.g. "widget-public", "openai-compat-private").
   */
  channel: string;
  sender?: string;
  conversationId?: string;
  text: string;
}

/**
 * Modifies or vetoes an already-produced reply, after `answerFn`/the built-in
 * completion and guardrails have run. A string result replaces the reply;
 * `null` vetoes it — treated the same as an empty answer by every call site
 * (nothing delivered; the channel pipeline never records an assistant turn
 * for it, though the user's own turn — already appended before answering —
 * stays recorded).
 *
 * Non-streaming surfaces only: a streaming response is delivered incrementally
 * as it's produced, before a final answer exists to transform.
 */
export type TransformReply = (input: TransformReplyInput) => string | null | Promise<string | null>;

/**
 * Runs `transformReply` if configured. A throw/rejection is logged and the
 * ORIGINAL text is returned — the delivery invariant: a bug in a plugin hook
 * must never silently swallow an answer the model already produced.
 */
export async function applyTransformReply(
  transformReply: TransformReply | undefined,
  input: TransformReplyInput,
  logger?: Pick<Logger, "error">,
): Promise<string | null> {
  if (!transformReply) return input.text;
  try {
    return await transformReply(input);
  } catch (error) {
    logger?.error(
      `transformReply threw for channel "${input.channel}"; sending the original reply`,
      error,
    );
    return input.text;
  }
}

/**
 * Stream an answer. A brain that returns a plain string cannot stream, so its
 * answer degrades to a single chunk followed by the stream's normal end —
 * streaming surfaces keep their wire format either way.
 *
 * Because a brain's answer arrives whole, it gets the full guardrails; the
 * built-in stream only scrubs each delta, since leakage detection needs text
 * no streamed chunk has yet.
 */
export async function* answerStream({
  answerFn,
  client,
  system,
  messages,
  mode,
  sender,
  conversationId,
  temperature,
  model,
}: AnswerOptions): AsyncGenerator<string> {
  if (answerFn) {
    const { content } = await runAnswerFn(answerFn, {
      system,
      messages,
      mode,
      sender,
      conversationId,
    });
    if (content) yield content;
    return;
  }
  yield* completeStream({ client, system, messages, temperature, model });
}
