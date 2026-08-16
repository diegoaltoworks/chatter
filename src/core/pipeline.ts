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
import type { VectorStore } from "./retrieval";

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

const MODE_SETTINGS: Record<PipelineMode, { topK: number; label: string }> = {
  public: { topK: 6, label: "Context" },
  private: { topK: 8, label: "Internal Context" },
};

/**
 * Run retrieval for the latest user message and assemble the system prompt.
 *
 * The assembled system prompt is layered, in order:
 * base rules → persona → channel hint (optional) → retrieved context.
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
  logger,
}: {
  store: VectorStore;
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
  /** Logs a `rewriteQuery`/`rerankContext` throw before falling back. Unset: the failure is silent. */
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

  let ctx = await store.query(query, topK, buckets ?? defaultBuckets(mode));
  if (rerankContext) {
    try {
      const reranked = await rerankContext({ query, chunks: ctx });
      if (Array.isArray(reranked) && reranked.every((c) => typeof c === "string")) ctx = reranked;
    } catch (error) {
      logger?.error("rerankContext threw; falling back to the original chunks", error);
    }
  }

  const persona =
    personaLayer?.trim() || (mode === "private" ? prompts.privatePersona : prompts.publicPersona);
  const hint = channelHint?.trim();
  const system = [
    prompts.baseSystemRules,
    persona,
    ...(hint ? [hint] : []),
    `${label}:\n${ctx.join("\n\n")}`,
  ].join("\n\n");

  return { system, messages, context: ctx };
}
