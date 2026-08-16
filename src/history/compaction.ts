/**
 * Summarize-then-truncate compaction for `HistoryStore` — folds older turns
 * into a single stored summary row once a conversation's window grows past a
 * threshold, so a long-running conversation's prompt doesn't grow without
 * bound. Off by default; a caller wires `maybeCompact` in right after its own
 * `store.append` call, the same way `./index`'s docs describe wiring the
 * store itself.
 *
 * The summarize step races a timeout the same way `../images/captionComposer`
 * races its compose step, except the safe fallback here is "leave history
 * untouched" rather than a template pool — a stuck or failing summarize call
 * must never lose turns nobody got to read back.
 */

import type OpenAI from "openai";
import { answerOnce } from "../core/answer";
import type { Logger } from "../core/logger";
import type { HistoryMessage, HistoryStore } from "./types";

/** What a summarize step receives: the turns being folded away, oldest first. Never includes the turns `keep` retains verbatim. */
export interface SummarizeRequest {
  conversationId: string;
  turns: HistoryMessage[];
}

/** Best-effort compaction step, typically an LLM call. */
export type SummarizeFn = (request: SummarizeRequest) => Promise<string>;

export interface HistoryCompactionOptions {
  /** Turn count that triggers compaction. */
  threshold: number;
  /** Most recent turns kept verbatim after compaction; everything older is folded into the summary. Must be less than `threshold`. */
  keep: number;
  /**
   * Best-effort summarize step. Defaults to `answerOnce` with a neutral
   * prompt and no `answerFn` (so it always uses the built-in completion,
   * never a caller's brain hook) — set this to route summarization through a
   * caller's own `answerFn`, a cheaper model, or a non-LLM summarizer.
   */
  summarize?: SummarizeFn;
  /** Model for the default `summarize` step. Ignored when `summarize` is supplied. Falls back to `answerOnce`'s own default model when unset. */
  model?: string;
  /** Milliseconds before `summarize` is abandoned in favour of leaving history untouched for this turn. @default 8000 */
  timeoutMs?: number;
  logger?: Pick<Logger, "error">;
}

export interface HistoryCompactor {
  /**
   * Compacts `conversationId` if its stored turn count has reached
   * `threshold`. A no-op below threshold. A failed or timed-out `summarize`
   * leaves the store exactly as it was and does not throw; a failure in the
   * store itself (`load`/`clear`/`append`) propagates like any other store
   * failure.
   */
  maybeCompact(store: HistoryStore, conversationId: string): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 8_000;

// `store.clear` below erases every row for the conversation, so compaction
// must read everything the store currently holds first — loading only
// `threshold` turns would silently discard any older turn beyond that
// window instead of folding it into the summary. Bounded in practice by
// whatever cap the store itself enforces (e.g. `maxPerConversation`).
const LOAD_ALL = Number.MAX_SAFE_INTEGER;

/** Marks a stored row as a compaction summary rather than a real turn — informational only, nothing parses it back out. */
export const SUMMARY_PREFIX = "Summary of earlier conversation: ";

function defaultSummarize(client: OpenAI, model: string | undefined): SummarizeFn {
  return async ({ turns }) => {
    const transcript = turns.map((turn) => `${turn.role}: ${turn.content}`).join("\n");
    const { content } = await answerOnce({
      client,
      system:
        "Summarize the conversation turns below into a short paragraph a reader would need to continue the conversation. Preserve names, facts, and decisions; drop pleasantries. Reply with the summary only, no preamble.",
      messages: [{ role: "user", content: transcript }],
      // No `answerFn`: compaction is an internal chatter operation, not a
      // chat surface, so it must not conscript a caller's brain hook, which
      // is shaped to answer the user, not to summarize on the engine's behalf.
      mode: "public",
      model,
    });
    return content;
  };
}

/**
 * `deps.client` builds the default `summarize` step; unused when a caller
 * supplies its own.
 */
export function createHistoryCompactor(
  deps: { client: OpenAI },
  options: HistoryCompactionOptions,
): HistoryCompactor {
  const { threshold, keep, logger } = options;
  if (!Number.isInteger(threshold) || threshold < 1) {
    throw new Error(`Invalid history compaction threshold: ${threshold}`);
  }
  if (!Number.isInteger(keep) || keep < 0 || keep >= threshold) {
    throw new Error(`Invalid history compaction keep: ${keep}`);
  }
  const summarize = options.summarize ?? defaultSummarize(deps.client, options.model);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async maybeCompact(store, conversationId) {
      const turns = await store.load(conversationId, LOAD_ALL);
      if (turns.length < threshold) return;

      // `keep < threshold` is validated above and `turns.length >= threshold`
      // is checked just above, so this always has at least one turn.
      const older = turns.slice(0, turns.length - keep);

      let summary: string;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        summary = await Promise.race([
          summarize({ conversationId, turns: older }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("history compaction timed out")), timeoutMs);
          }),
        ]);
      } catch (error) {
        logger?.error(
          `history compaction summarize failed for "${conversationId}"; history left untouched`,
          error,
        );
        return;
      } finally {
        clearTimeout(timer);
      }

      const trimmed = summary.trim();
      if (!trimmed) return;

      // `summarize` can take up to `timeoutMs` — long enough for another
      // instance to append a fresh turn mid-call. Re-reading now, instead of
      // reusing `turns`' stale tail, means only turns actually covered by
      // `older` are folded away; anything appended during the summarize call
      // survives in `recent`. Not transactional even so: any HistoryStore
      // here only exposes append/load/clear, so the rewrite below is still
      // clear-then-append rather than one atomic statement, and a crash
      // between the two would lose `recent` — an accepted, documented
      // tradeoff of the structural store contract (see docs/history.md).
      const fresh = await store.load(conversationId, LOAD_ALL);
      const recent = fresh.slice(older.length);

      await store.clear(conversationId);
      await store.append(conversationId, {
        role: "assistant",
        content: `${SUMMARY_PREFIX}${trimmed}`,
      });
      for (const turn of recent) {
        await store.append(conversationId, turn);
      }
    },
  };
}
