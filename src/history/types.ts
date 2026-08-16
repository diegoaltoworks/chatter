/** One turn of conversation history. */
export interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Structural, host-replaceable conversation history — the `FlowSessionStore`/
 * `DailyLimitsStore` pattern applied to multi-turn context. A channel that
 * knows a `conversationId` loads recent turns before answering and appends
 * the new turn after, rather than each surface hand-rolling its own history.
 */
export interface HistoryStore {
  /** Append one turn to `conversationId`'s history. */
  append(conversationId: string, message: HistoryMessage): Promise<void>;
  /** Load up to `limit` most recent turns for `conversationId`, oldest first. */
  load(conversationId: string, limit: number): Promise<HistoryMessage[]>;
  /** Reset primitive: erases all of `conversationId`'s history. Other conversations are untouched. */
  clear(conversationId: string): Promise<void>;
}
