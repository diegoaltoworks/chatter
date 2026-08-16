/**
 * Conversation history — a structural, host-replaceable store for multi-turn
 * context, following the `FlowSessionStore`/`DailyLimitsStore` pattern.
 * Published as the `@diegoaltoworks/chatter/history` subpath so the core
 * install stays untouched by it, and so every channel stays single-turn
 * until it opts in.
 *
 * The interface is deliberately small — `append`/`load(conversationId,
 * limit)` — so any backing store (Turso, Redis, a host's own database) can
 * implement it. The shipped Turso implementation needs `@libsql/client`,
 * which chatter already expects for retrieval.
 *
 * `./compaction` is an optional layer on top: summarize-then-truncate for a
 * conversation whose window has grown past a threshold, built entirely on
 * the store's own `load`/`clear`/`append` so it works with any
 * `HistoryStore`, not just the Turso one.
 *
 * @packageDocumentation
 */

export type {
  HistoryCompactionOptions,
  HistoryCompactor,
  SummarizeFn,
  SummarizeRequest,
} from "./compaction";
export { createHistoryCompactor, SUMMARY_PREFIX } from "./compaction";
export type { TursoHistoryStoreOptions } from "./tursoStore";
export { createTursoHistoryStore } from "./tursoStore";
export type { HistoryMessage, HistoryStore } from "./types";
