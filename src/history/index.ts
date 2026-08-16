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
 * @packageDocumentation
 */

export { createTursoHistoryStore } from "./tursoStore";
export type { HistoryMessage, HistoryStore } from "./types";
