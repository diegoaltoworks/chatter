/**
 * History compaction tests — a fake store (matching `HistoryStore`) and a
 * fake OpenAI client (matching `../core/answer.test.ts`'s pattern) so the
 * threshold/summarize/rewrite logic is proven without a real database or
 * a real LLM call.
 */

import { describe, expect, test } from "bun:test";
import type OpenAI from "openai";
import { createHistoryCompactor, SUMMARY_PREFIX } from "./compaction";
import type { HistoryMessage, HistoryStore } from "./types";

function fakeStore(): HistoryStore & { data: Map<string, HistoryMessage[]> } {
  const data = new Map<string, HistoryMessage[]>();
  return {
    data,
    async append(conversationId, message) {
      const turns = data.get(conversationId) ?? [];
      turns.push(message);
      data.set(conversationId, turns);
    },
    async load(conversationId, limit) {
      return (data.get(conversationId) ?? []).slice(-limit);
    },
    async clear(conversationId) {
      data.delete(conversationId);
    },
  };
}

async function seed(store: HistoryStore, conversationId: string, count: number) {
  for (let i = 0; i < count; i++) {
    await store.append(conversationId, { role: "user", content: `turn ${i}` });
  }
}

function fakeClient(reply = "built-in summary") {
  return {
    chat: { completions: { create: async () => ({ choices: [{ message: { content: reply } }] }) } },
  } as unknown as OpenAI;
}

describe("createHistoryCompactor", () => {
  test("rejects an invalid threshold or keep", () => {
    const client = fakeClient();
    expect(() => createHistoryCompactor({ client }, { threshold: 0, keep: 0 })).toThrow(
      "Invalid history compaction threshold",
    );
    expect(() => createHistoryCompactor({ client }, { threshold: 5, keep: -1 })).toThrow(
      "Invalid history compaction keep",
    );
    expect(() => createHistoryCompactor({ client }, { threshold: 5, keep: 5 })).toThrow(
      "Invalid history compaction keep",
    );
  });

  test("below threshold: no-op, store untouched", async () => {
    const store = fakeStore();
    await seed(store, "conv-1", 3);
    const compactor = createHistoryCompactor({ client: fakeClient() }, { threshold: 5, keep: 2 });

    await compactor.maybeCompact(store, "conv-1");

    expect(store.data.get("conv-1")).toHaveLength(3);
  });

  test("at threshold: summarizes older turns into a prefixed row, keeps the rest verbatim", async () => {
    const store = fakeStore();
    await seed(store, "conv-1", 5);
    let request: unknown;
    const compactor = createHistoryCompactor(
      { client: fakeClient() },
      {
        threshold: 5,
        keep: 2,
        summarize: async (req) => {
          request = req;
          return "the gist of it";
        },
      },
    );

    await compactor.maybeCompact(store, "conv-1");

    expect(request).toEqual({
      conversationId: "conv-1",
      turns: [
        { role: "user", content: "turn 0" },
        { role: "user", content: "turn 1" },
        { role: "user", content: "turn 2" },
      ],
    });
    expect(await store.load("conv-1", 10)).toEqual([
      { role: "assistant", content: `${SUMMARY_PREFIX}the gist of it` },
      { role: "user", content: "turn 3" },
      { role: "user", content: "turn 4" },
    ]);
  });

  test("a conversation with more turns than threshold folds ALL of them in, not just the most recent threshold-sized window", async () => {
    const store = fakeStore();
    await seed(store, "conv-1", 8);
    let request: unknown;
    const compactor = createHistoryCompactor(
      { client: fakeClient() },
      {
        threshold: 4,
        keep: 1,
        summarize: async (req) => {
          request = req;
          return "the gist";
        },
      },
    );

    await compactor.maybeCompact(store, "conv-1");

    // Every turn older than `keep` must have reached `summarize` — none
    // silently dropped just because they fell outside a `threshold`-sized
    // read, since `store.clear()` below would otherwise have erased them
    // without ever having been folded into the summary.
    expect((request as { turns: HistoryMessage[] }).turns).toHaveLength(7);
    expect(await store.load("conv-1", 10)).toEqual([
      { role: "assistant", content: `${SUMMARY_PREFIX}the gist` },
      { role: "user", content: "turn 7" },
    ]);
  });

  test("a turn appended while summarize is running survives, rather than being wiped by the rewrite", async () => {
    const store = fakeStore();
    await seed(store, "conv-1", 3);
    const compactor = createHistoryCompactor(
      { client: fakeClient() },
      {
        threshold: 3,
        keep: 1,
        // Stands in for another instance appending a turn for this same
        // conversation while this summarize call is still in flight.
        summarize: async () => {
          await store.append("conv-1", { role: "user", content: "concurrent" });
          return "the gist";
        },
      },
    );

    await compactor.maybeCompact(store, "conv-1");

    expect(await store.load("conv-1", 10)).toEqual([
      { role: "assistant", content: `${SUMMARY_PREFIX}the gist` },
      { role: "user", content: "turn 2" },
      { role: "user", content: "concurrent" },
    ]);
  });

  test("uses the default completion path (via answerOnce, never a caller's own answerFn)", async () => {
    const store = fakeStore();
    await seed(store, "conv-1", 4);
    const compactor = createHistoryCompactor(
      { client: fakeClient("condensed") },
      { threshold: 4, keep: 1 },
    );

    await compactor.maybeCompact(store, "conv-1");

    expect(await store.load("conv-1", 10)).toEqual([
      { role: "assistant", content: `${SUMMARY_PREFIX}condensed` },
      { role: "user", content: "turn 3" },
    ]);
  });

  test("the configured model reaches the default summarizer's completion call", async () => {
    const store = fakeStore();
    await seed(store, "conv-1", 4);
    const calls: string[] = [];
    const client = {
      chat: {
        completions: {
          create: async (opts: { model: string }) => {
            calls.push(opts.model);
            return { choices: [{ message: { content: "condensed" } }] };
          },
        },
      },
    } as unknown as OpenAI;
    const compactor = createHistoryCompactor(
      { client },
      { threshold: 4, keep: 1, model: "gpt-4o-mini" },
    );

    await compactor.maybeCompact(store, "conv-1");

    expect(calls).toEqual(["gpt-4o-mini"]);
  });

  test("a store failure during the rewrite propagates rather than being swallowed", async () => {
    const store = fakeStore();
    await seed(store, "conv-1", 4);
    let clearCalled = false;
    const failingStore: HistoryStore = {
      ...store,
      async clear(conversationId) {
        clearCalled = true;
        await store.clear(conversationId);
      },
      async append(conversationId, message) {
        if (clearCalled) throw new Error("store unavailable");
        await store.append(conversationId, message);
      },
    };
    const compactor = createHistoryCompactor(
      { client: fakeClient() },
      { threshold: 4, keep: 1, summarize: async () => "the gist" },
    );

    await expect(compactor.maybeCompact(failingStore, "conv-1")).rejects.toThrow(
      "store unavailable",
    );
  });

  test("a throwing summarize leaves history completely untouched", async () => {
    const store = fakeStore();
    await seed(store, "conv-1", 5);
    const errors: unknown[] = [];
    const compactor = createHistoryCompactor(
      { client: fakeClient() },
      {
        threshold: 5,
        keep: 2,
        summarize: async () => {
          throw new Error("boom");
        },
        logger: { error: (...args) => errors.push(args) },
      },
    );

    await compactor.maybeCompact(store, "conv-1");

    expect(store.data.get("conv-1")).toHaveLength(5);
    expect(errors).toHaveLength(1);
  });

  test("a slow summarize times out and leaves history untouched", async () => {
    const store = fakeStore();
    await seed(store, "conv-1", 5);
    const compactor = createHistoryCompactor(
      { client: fakeClient() },
      {
        threshold: 5,
        keep: 2,
        timeoutMs: 5,
        summarize: () => new Promise(() => {}),
      },
    );

    await compactor.maybeCompact(store, "conv-1");

    expect(store.data.get("conv-1")).toHaveLength(5);
  });

  test("an empty or blank summary leaves history untouched", async () => {
    const store = fakeStore();
    await seed(store, "conv-1", 5);
    const compactor = createHistoryCompactor(
      { client: fakeClient() },
      { threshold: 5, keep: 2, summarize: async () => "   " },
    );

    await compactor.maybeCompact(store, "conv-1");

    expect(store.data.get("conv-1")).toHaveLength(5);
  });

  test("keep of 0 folds every loaded turn into the summary, none kept verbatim", async () => {
    const store = fakeStore();
    await seed(store, "conv-1", 3);
    const compactor = createHistoryCompactor(
      { client: fakeClient() },
      { threshold: 3, keep: 0, summarize: async () => "all of it" },
    );

    await compactor.maybeCompact(store, "conv-1");

    expect(await store.load("conv-1", 10)).toEqual([
      { role: "assistant", content: `${SUMMARY_PREFIX}all of it` },
    ]);
  });

  test("compacting again below the new threshold is a no-op", async () => {
    const store = fakeStore();
    await seed(store, "conv-1", 5);
    const compactor = createHistoryCompactor(
      { client: fakeClient() },
      { threshold: 5, keep: 2, summarize: async () => "summary one" },
    );

    await compactor.maybeCompact(store, "conv-1");
    expect(store.data.get("conv-1")).toHaveLength(3);

    await compactor.maybeCompact(store, "conv-1");
    expect(store.data.get("conv-1")).toHaveLength(3);
  });
});
