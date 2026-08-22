/**
 * Chat pipeline — RAG prompt assembly, decoupled from any transport or UI.
 *
 * This is the single place where a conversation is turned into a
 * retrieval-augmented completion request. Every surface (widget routes,
 * OpenAI-compatible routes, MCP, programmatic use) should go through here
 * so behaviour stays identical regardless of how the chat is consumed, and
 * then ask for the answer via `answerOnce`/`answerStream` (see ./answer.ts)
 * so a caller-supplied brain is honoured.
 */

import { defaultBuckets } from "./buckets";
import type { Logger } from "./logger";
import { lastUserMessage } from "./messages";
import type { PromptLoader } from "./prompts";
import type { Retriever } from "./retrieval";

export type PipelineMode = "public" | "private";

export interface PipelineMessage {
  role: "user" | "assistant";
  content: string;
}

export interface PreparedChat {
  /** Fully assembled system prompt (see `prepareChat` for the layer order) */
  system: string;
  /** Conversation messages, unchanged */
  messages: PipelineMessage[];
  /** Raw retrieved chunks, before being folded into `system` — for callers that log or display RAG context alongside the answer */
  context: string[];
}

/** What `rewriteQuery` sees for a turn. */
export interface RewriteQueryArgs {
  /** The latest user message's content — what retrieval would search on unmodified. */
  query: string;
  mode: PipelineMode;
  /** Caller identity, where the surface has one. Absent on anonymous surfaces. */
  sender?: string;
}

/**
 * Rewrites the retrieval query before it reaches the vector store — e.g.
 * expanding an ambiguous follow-up ("what about the second one?") into
 * something embeddable on its own. Return the query unchanged to opt out for
 * a given turn. A throw/rejection is caught by `prepareChat`, which falls
 * back to the original query — a broken rewrite must never break retrieval.
 */
export type RewriteQuery = (ctx: RewriteQueryArgs) => string | Promise<string>;

/** What `rerankContext` sees for a turn. */
export interface RerankContextArgs {
  /** The query retrieval actually ran with — post-`rewriteQuery`, if configured. */
  query: string;
  /** Chunks `store.query` returned, in its own order. */
  chunks: string[];
}

/**
 * Reorders, filters, or otherwise post-processes the chunks retrieval
 * returned before they're folded into the system prompt. A throw/rejection
 * is caught by `prepareChat`, which falls back to the original chunks in
 * their original order — a broken reranker must never break retrieval.
 *
 * This is NOT the seam for access control. Because a failure falls back to
 * the unfiltered chunks, a hook that drops chunks a sender shouldn't see
 * would silently un-drop them on its own error — the opposite of safe
 * failure. Scope decisions belong in `bucketsFor` (see ./buckets), which
 * fails closed by design; use this hook for relevance/ordering only.
 */
export type RerankContext = (ctx: RerankContextArgs) => string[] | Promise<string[]>;

/** What `fallbackFn` sees for a turn where retrieval came back empty. */
export interface FallbackContext {
  /** The query retrieval actually ran with, post-`rewriteQuery` if configured. */
  query: string;
  mode: PipelineMode;
  /** Buckets retrieval ran against for this turn. */
  buckets: string[];
  /** Caller identity, where the surface has one. Absent on anonymous surfaces. */
  sender?: string;
  /**
   * What `store.query` returned for this turn, before `rerankContext` ran.
   * `fallbackFn` runs only when the post-rerank context is empty, so this
   * array is non-empty exactly when `rerankContext` filtered every retrieved
   * chunk out, and empty exactly when the store itself found nothing. A hook
   * can use that to tell "some low-confidence signal existed" apart from
   * "nothing matched at all". It is a copy, so mutating it in place cannot
   * change the context the turn goes on to answer with.
   */
  retrievedChunks: string[];
}

/**
 * Runs only when retrieval produced no chunks for a turn (after
 * `rerankContext`, if configured), the deterministic, testable alternative
 * to baking "what if there's nothing to retrieve" judgment calls into
 * freeform system-prompt text. Return a string to inject as an extra system
 * prompt layer scoped to this turn only (e.g. "no matching context was
 * found; offer a clearly-labelled guess or decline"); return `undefined` to
 * leave the prompt exactly as it would be otherwise.
 *
 * A throw/rejection is caught by `prepareChat`, which proceeds without
 * fallback guidance: a broken hook must never break the chat path.
 */
export type FallbackFn = (ctx: FallbackContext) => string | undefined | Promise<string | undefined>;

const MODE_SETTINGS: Record<PipelineMode, { topK: number; label: string }> = {
  public: { topK: 6, label: "Context" },
  private: { topK: 8, label: "Internal Context" },
};

/**
 * Run retrieval for the latest user message and assemble the system prompt.
 *
 * The assembled system prompt is layered, in order:
 * base rules → persona → channel hint (optional) → fallback guidance
 * (optional, only when retrieval came back empty) → retrieved context.
 *
 * `personaLayer` and `channelHint` let a caller shape those middle layers
 * without hand-rolling its own sandwich around `store`/`prompts`. Both are
 * optional, and blank (or whitespace-only) values are ignored: omit them and
 * the prompt is exactly what it has always been.
 *
 * `buckets` does the same for retrieval scope. It is taken at face value —
 * this is the low-level primitive, and it trusts its caller. A surface that
 * derives buckets from anything a request controls must run them through
 * `resolveBuckets` (see ./buckets) first, which is where the anonymous
 * ceiling is enforced.
 *
 * `rewriteQuery` and `rerankContext` shape retrieval itself rather than the
 * prompt around it: the former runs before `store.query`, the latter after.
 * Both are optional and fail open — a throw, rejection, or malformed return
 * value falls back to what retrieval would have done unmodified, so a buggy
 * hook degrades relevance rather than breaking the chat path.
 *
 * `fallbackFn` runs after both, only when the chunks folded into the prompt
 * would otherwise be empty, see {@link FallbackFn}.
 *
 * @throws if the conversation contains no user message
 */
export async function prepareChat({
  store,
  prompts,
  mode,
  messages,
  personaLayer,
  channelHint,
  buckets,
  sender,
  rewriteQuery,
  rerankContext,
  fallbackFn,
  logger,
}: {
  store: Retriever;
  prompts: PromptLoader;
  mode: PipelineMode;
  messages: PipelineMessage[];
  /** Replaces the mode's persona from the loader when provided */
  personaLayer?: string;
  /** Extra system-prompt section describing the delivery channel */
  channelHint?: string;
  /**
   * Retrieval buckets for this turn, replacing the mode default of
   * `["base", mode]`. An empty array retrieves nothing.
   */
  buckets?: string[];
  /** Caller identity, passed through to `rewriteQuery`. Absent on anonymous surfaces. */
  sender?: string;
  /** Rewrites the retrieval query before `store.query` runs — see {@link RewriteQuery}. */
  rewriteQuery?: RewriteQuery;
  /** Post-processes retrieved chunks before they're folded into the prompt — see {@link RerankContext}. */
  rerankContext?: RerankContext;
  /** Injects fallback guidance when retrieval comes back empty, see {@link FallbackFn}. */
  fallbackFn?: FallbackFn;
  /** Logs a `rewriteQuery`/`rerankContext`/`fallbackFn` throw before falling back. Unset: the failure is silent. */
  logger?: Pick<Logger, "error">;
}): Promise<PreparedChat> {
  const lastUserMsg = lastUserMessage(messages);
  if (!lastUserMsg) {
    throw new Error("no user message found in conversation");
  }

  const { topK, label } = MODE_SETTINGS[mode];

  let query = lastUserMsg.content;
  if (rewriteQuery) {
    try {
      const rewritten = await rewriteQuery({ query, mode, sender });
      if (typeof rewritten === "string" && rewritten.trim()) query = rewritten;
    } catch (error) {
      logger?.error("rewriteQuery threw; falling back to the original query", error);
    }
  }

  const resolvedBuckets = buckets ?? defaultBuckets(mode);
  const retrievedChunks = await store.query(query, topK, resolvedBuckets);
  let ctx = retrievedChunks;
  if (rerankContext) {
    try {
      // A copy, not `ctx` itself: a reranker that filters in place (rather
      // than returning a new array) must not be able to mutate the snapshot
      // `fallbackFn` later reads as `retrievedChunks`.
      const reranked = await rerankContext({ query, chunks: [...ctx] });
      if (Array.isArray(reranked) && reranked.every((c) => typeof c === "string")) ctx = reranked;
    } catch (error) {
      logger?.error("rerankContext threw; falling back to the original chunks", error);
    }
  }

  let fallback: string | undefined;
  if (ctx.length === 0 && fallbackFn) {
    try {
      const guidance = await fallbackFn({
        query,
        mode,
        buckets: resolvedBuckets,
        sender,
        // A copy for the same reason the reranker gets one. Whenever `ctx` is
        // still the array the store returned (no reranker, or one that threw
        // or returned a non-array), the two are the same object, so whatever a
        // hook pushed onto its argument would land in the context assembled
        // below.
        retrievedChunks: [...retrievedChunks],
      });
      if (typeof guidance === "string" && guidance.trim()) fallback = guidance.trim();
    } catch (error) {
      logger?.error("fallbackFn threw; proceeding without fallback guidance", error);
    }
  }

  const persona =
    personaLayer?.trim() || (mode === "private" ? prompts.privatePersona : prompts.publicPersona);
  const hint = channelHint?.trim();
  const system = [
    prompts.baseSystemRules,
    persona,
    ...(hint ? [hint] : []),
    ...(fallback ? [fallback] : []),
    `${label}:\n${ctx.join("\n\n")}`,
  ].join("\n\n");

  return { system, messages, context: ctx };
}
