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
  { system, messages, mode, sender }: AnswerFnInput,
): Promise<{ content: string; usage: AnswerUsage }> {
  const result = await answerFn({ system, messages, mode, sender });
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
  temperature,
  model,
}: AnswerOptions): Promise<{ content: string; usage: AnswerUsage }> {
  if (answerFn) {
    return runAnswerFn(answerFn, { system, messages, mode, sender });
  }
  return completeOnce({ client, system, messages, temperature, model });
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
  temperature,
  model,
}: AnswerOptions): AsyncGenerator<string> {
  if (answerFn) {
    const { content } = await runAnswerFn(answerFn, { system, messages, mode, sender });
    if (content) yield content;
    return;
  }
  yield* completeStream({ client, system, messages, temperature, model });
}
