/**
 * Chat pipeline tests
 *
 * Uses faked prompts and vector store so prompt assembly can be asserted
 * without touching OpenAI or Turso.
 */

import { describe, expect, test } from "bun:test";
import { type PipelineMessage, prepareChat } from "./pipeline";
import type { PromptLoader } from "./prompts";
import type { Retriever } from "./retrieval";

interface QueryCall {
  query: string;
  topK: number;
  buckets: string[];
}

function createFakes() {
  const queries: QueryCall[] = [];

  const store = {
    query: async (query: string, topK: number, buckets: string[]) => {
      queries.push({ query, topK, buckets });
      return ["some context"];
    },
  } satisfies Retriever;

  const prompts = {
    baseSystemRules: "rules",
    publicPersona: "public persona",
    privatePersona: "private persona",
  } as unknown as PromptLoader;

  return { store, prompts, queries };
}

const messages: PipelineMessage[] = [
  { role: "user", content: "first" },
  { role: "assistant", content: "reply" },
  { role: "user", content: "latest question" },
];

describe("prepareChat", () => {
  test("retrieves against the latest user message with the mode's settings", async () => {
    const { store, prompts, queries } = createFakes();

    await prepareChat({ store, prompts, mode: "public", messages });

    expect(queries).toEqual([{ query: "latest question", topK: 6, buckets: ["base", "public"] }]);
  });

  test("assembles rules, persona and context for public mode", async () => {
    const { store, prompts } = createFakes();

    const result = await prepareChat({ store, prompts, mode: "public", messages });

    expect(result.system).toBe("rules\n\npublic persona\n\nContext:\nsome context");
    expect(result.messages).toBe(messages);
  });

  test("returns the raw retrieved chunks alongside the assembled system prompt", async () => {
    const { store, prompts } = createFakes();

    const result = await prepareChat({ store, prompts, mode: "public", messages });

    expect(result.context).toEqual(["some context"]);
  });

  test("uses the private persona, label and topK for private mode", async () => {
    const { store, prompts, queries } = createFakes();

    const result = await prepareChat({ store, prompts, mode: "private", messages });

    expect(result.system).toBe("rules\n\nprivate persona\n\nInternal Context:\nsome context");
    expect(queries[0]).toEqual({
      query: "latest question",
      topK: 8,
      buckets: ["base", "private"],
    });
  });

  test("throws when the conversation has no user message", async () => {
    const { store, prompts } = createFakes();

    await expect(
      prepareChat({
        store,
        prompts,
        mode: "public",
        messages: [{ role: "assistant", content: "hi" }],
      }),
    ).rejects.toThrow("no user message found");
  });

  describe("personaLayer", () => {
    test("replaces the mode persona when provided", async () => {
      const { store, prompts } = createFakes();

      const result = await prepareChat({
        store,
        prompts,
        mode: "public",
        messages,
        personaLayer: "caller persona",
      });

      expect(result.system).toBe("rules\n\ncaller persona\n\nContext:\nsome context");
      expect(result.system).not.toContain("public persona");
    });

    test("replaces the private persona too", async () => {
      const { store, prompts } = createFakes();

      const result = await prepareChat({
        store,
        prompts,
        mode: "private",
        messages,
        personaLayer: "caller persona",
      });

      expect(result.system).toBe("rules\n\ncaller persona\n\nInternal Context:\nsome context");
    });

    test("falls back to the mode persona when blank", async () => {
      const { store, prompts } = createFakes();

      for (const personaLayer of ["", "   \n "]) {
        const result = await prepareChat({
          store,
          prompts,
          mode: "public",
          messages,
          personaLayer,
        });

        expect(result.system).toBe("rules\n\npublic persona\n\nContext:\nsome context");
      }
    });
  });

  describe("buckets", () => {
    test("replaces the mode defaults when provided", async () => {
      const { store, prompts, queries } = createFakes();

      await prepareChat({
        store,
        prompts,
        mode: "private",
        messages,
        buckets: ["base", "finance"],
      });

      expect(queries[0]).toEqual({
        query: "latest question",
        topK: 8,
        buckets: ["base", "finance"],
      });
    });

    test("keeps the mode topK and prompt layers", async () => {
      const { store, prompts } = createFakes();

      const result = await prepareChat({
        store,
        prompts,
        mode: "public",
        messages,
        buckets: ["base"],
      });

      expect(result.system).toBe("rules\n\npublic persona\n\nContext:\nsome context");
    });

    test("falls back to the mode defaults when omitted", async () => {
      const { store, prompts, queries } = createFakes();

      await prepareChat({ store, prompts, mode: "private", messages, buckets: undefined });

      expect(queries[0]?.buckets).toEqual(["base", "private"]);
    });

    test("an empty array retrieves nothing rather than reverting to defaults", async () => {
      const { store, prompts, queries } = createFakes();

      // Reverting here would hand back the private bucket exactly when a
      // caller had scoped it away.
      await prepareChat({ store, prompts, mode: "private", messages, buckets: [] });

      expect(queries[0]?.buckets).toEqual([]);
    });
  });

  describe("channelHint", () => {
    test("sits between persona and context", async () => {
      const { store, prompts } = createFakes();

      const result = await prepareChat({
        store,
        prompts,
        mode: "public",
        messages,
        channelHint: "Channel: SMS. Keep it short.",
      });

      expect(result.system).toBe(
        "rules\n\npublic persona\n\nChannel: SMS. Keep it short.\n\nContext:\nsome context",
      );
    });

    test("combines with personaLayer in layer order", async () => {
      const { store, prompts } = createFakes();

      const result = await prepareChat({
        store,
        prompts,
        mode: "public",
        messages,
        personaLayer: "caller persona",
        channelHint: "Channel: SMS.",
      });

      expect(result.system).toBe(
        "rules\n\ncaller persona\n\nChannel: SMS.\n\nContext:\nsome context",
      );
    });

    test("adds no section when blank", async () => {
      const { store, prompts } = createFakes();

      for (const channelHint of ["", "   \n "]) {
        const result = await prepareChat({ store, prompts, mode: "public", messages, channelHint });

        expect(result.system).toBe("rules\n\npublic persona\n\nContext:\nsome context");
      }
    });
  });

  describe("rewriteQuery", () => {
    test("replaces the query store.query runs against", async () => {
      const { store, prompts, queries } = createFakes();

      await prepareChat({
        store,
        prompts,
        mode: "public",
        messages,
        rewriteQuery: async ({ query }) => `expanded: ${query}`,
      });

      expect(queries[0]?.query).toBe("expanded: latest question");
    });

    test("receives mode and sender", async () => {
      const { store, prompts } = createFakes();
      const seen: Array<{ query: string; mode: string; sender?: string }> = [];

      await prepareChat({
        store,
        prompts,
        mode: "private",
        messages,
        sender: "user-1",
        rewriteQuery: async (ctx) => {
          seen.push(ctx);
          return ctx.query;
        },
      });

      expect(seen).toEqual([{ query: "latest question", mode: "private", sender: "user-1" }]);
    });

    test("falls back to the original query when the hook throws", async () => {
      const { store, prompts, queries } = createFakes();

      await prepareChat({
        store,
        prompts,
        mode: "public",
        messages,
        rewriteQuery: async () => {
          throw new Error("boom");
        },
      });

      expect(queries[0]?.query).toBe("latest question");
    });

    test("falls back to the original query when the hook returns a blank string", async () => {
      const { store, prompts, queries } = createFakes();

      await prepareChat({
        store,
        prompts,
        mode: "public",
        messages,
        rewriteQuery: async () => "   ",
      });

      expect(queries[0]?.query).toBe("latest question");
    });
  });

  describe("rerankContext", () => {
    test("replaces the chunks folded into the system prompt", async () => {
      const { prompts } = createFakes();
      const store = {
        query: async () => ["first chunk", "second chunk"],
      } satisfies Retriever;

      const result = await prepareChat({
        store,
        prompts,
        mode: "public",
        messages,
        rerankContext: async ({ chunks }) => [...chunks].reverse(),
      });

      expect(result.context).toEqual(["second chunk", "first chunk"]);
      expect(result.system).toBe(
        "rules\n\npublic persona\n\nContext:\nsecond chunk\n\nfirst chunk",
      );
    });

    test("receives the rewritten query, not the original", async () => {
      const { store, prompts } = createFakes();
      const seen: Array<{ query: string; chunks: string[] }> = [];

      await prepareChat({
        store,
        prompts,
        mode: "public",
        messages,
        rewriteQuery: async () => "rewritten",
        rerankContext: async (ctx) => {
          seen.push(ctx);
          return ctx.chunks;
        },
      });

      expect(seen).toEqual([{ query: "rewritten", chunks: ["some context"] }]);
    });

    test("falls back to the original chunks when the hook throws", async () => {
      const { store, prompts } = createFakes();

      const result = await prepareChat({
        store,
        prompts,
        mode: "public",
        messages,
        rerankContext: async () => {
          throw new Error("boom");
        },
      });

      expect(result.context).toEqual(["some context"]);
    });

    test("falls back to the original chunks when the hook returns something malformed", async () => {
      const { store, prompts } = createFakes();

      const result = await prepareChat({
        store,
        prompts,
        mode: "public",
        messages,
        // @ts-expect-error — proving a malformed return value is rejected, not just an empty array
        rerankContext: async () => "not an array",
      });

      expect(result.context).toEqual(["some context"]);
    });
  });

  describe("fallbackFn", () => {
    test("is not consulted when retrieval returns chunks", async () => {
      const { store, prompts } = createFakes();
      let called = false;

      const result = await prepareChat({
        store,
        prompts,
        mode: "public",
        messages,
        fallbackFn: () => {
          called = true;
          return "should not appear";
        },
      });

      expect(called).toBe(false);
      expect(result.system).toBe("rules\n\npublic persona\n\nContext:\nsome context");
    });

    test("injects guidance as its own layer when retrieval returns nothing", async () => {
      const { prompts } = createFakes();
      const store = { query: async () => [] } satisfies Retriever;

      const result = await prepareChat({
        store,
        prompts,
        mode: "public",
        messages,
        fallbackFn: () => "Offer a clearly-labelled guess, or decline if truly out of scope.",
      });

      expect(result.system).toBe(
        "rules\n\npublic persona\n\nOffer a clearly-labelled guess, or decline if truly out of scope.\n\nContext:\n",
      );
    });

    test("receives the query, mode, buckets, sender and the chunks store.query returned", async () => {
      const store = { query: async () => [] } satisfies Retriever;
      const { prompts } = createFakes();
      const seen: unknown[] = [];

      await prepareChat({
        store,
        prompts,
        mode: "private",
        messages,
        sender: "user-1",
        buckets: ["base", "finance"],
        fallbackFn: (ctx) => {
          seen.push(ctx);
          return undefined;
        },
      });

      expect(seen).toEqual([
        {
          query: "latest question",
          mode: "private",
          buckets: ["base", "finance"],
          sender: "user-1",
          retrievedChunks: [],
        },
      ]);
    });

    test("sees the chunks store.query returned even when rerankContext filtered them all out", async () => {
      const store = { query: async () => ["weak match"] } satisfies Retriever;
      const { prompts } = createFakes();
      const seen: string[][] = [];

      await prepareChat({
        store,
        prompts,
        mode: "public",
        messages,
        rerankContext: async () => [],
        fallbackFn: (ctx) => {
          seen.push(ctx.retrievedChunks);
          return undefined;
        },
      });

      expect(seen).toEqual([["weak match"]]);
    });

    test("retrievedChunks survives a rerankContext that filters in place rather than returning a new array", async () => {
      const store = { query: async () => ["weak match"] } satisfies Retriever;
      const { prompts } = createFakes();
      const seen: string[][] = [];

      await prepareChat({
        store,
        prompts,
        mode: "public",
        messages,
        rerankContext: async ({ chunks }) => {
          chunks.length = 0;
          return chunks;
        },
        fallbackFn: (ctx) => {
          seen.push(ctx.retrievedChunks);
          return undefined;
        },
      });

      expect(seen).toEqual([["weak match"]]);
    });

    test("returning undefined leaves the prompt unchanged", async () => {
      const store = { query: async () => [] } satisfies Retriever;
      const { prompts } = createFakes();

      const result = await prepareChat({
        store,
        prompts,
        mode: "public",
        messages,
        fallbackFn: () => undefined,
      });

      expect(result.system).toBe("rules\n\npublic persona\n\nContext:\n");
    });

    test("a blank string is treated the same as undefined", async () => {
      const store = { query: async () => [] } satisfies Retriever;
      const { prompts } = createFakes();

      const result = await prepareChat({
        store,
        prompts,
        mode: "public",
        messages,
        fallbackFn: () => "   ",
      });

      expect(result.system).toBe("rules\n\npublic persona\n\nContext:\n");
    });

    test("a throw is swallowed and the prompt proceeds without fallback guidance", async () => {
      const store = { query: async () => [] } satisfies Retriever;
      const { prompts } = createFakes();

      const result = await prepareChat({
        store,
        prompts,
        mode: "public",
        messages,
        fallbackFn: () => {
          throw new Error("boom");
        },
      });

      expect(result.system).toBe("rules\n\npublic persona\n\nContext:\n");
    });

    test("logs a throwing fallbackFn instead of failing silently", async () => {
      const store = { query: async () => [] } satisfies Retriever;
      const { prompts } = createFakes();
      const errors: unknown[][] = [];
      const logger = { error: (...args: unknown[]) => errors.push(args) };

      await prepareChat({
        store,
        prompts,
        mode: "public",
        messages,
        logger,
        fallbackFn: () => {
          throw new Error("boom");
        },
      });

      expect(errors).toHaveLength(1);
      expect(String(errors[0]?.[0])).toContain("fallbackFn");
    });
  });

  describe("fail-open logging", () => {
    function fakeLogger() {
      const errors: unknown[][] = [];
      return { errors, error: (...args: unknown[]) => errors.push(args) };
    }

    test("logs a throwing rewriteQuery instead of failing silently", async () => {
      const { store, prompts } = createFakes();
      const logger = fakeLogger();

      await prepareChat({
        store,
        prompts,
        mode: "public",
        messages,
        logger,
        rewriteQuery: async () => {
          throw new Error("boom");
        },
      });

      expect(logger.errors).toHaveLength(1);
      expect(String(logger.errors[0]?.[0])).toContain("rewriteQuery");
    });

    test("logs a throwing rerankContext instead of failing silently", async () => {
      const { store, prompts } = createFakes();
      const logger = fakeLogger();

      await prepareChat({
        store,
        prompts,
        mode: "public",
        messages,
        logger,
        rerankContext: async () => {
          throw new Error("boom");
        },
      });

      expect(logger.errors).toHaveLength(1);
      expect(String(logger.errors[0]?.[0])).toContain("rerankContext");
    });

    test("no logger configured means the failure is silent, not thrown", async () => {
      const { store, prompts } = createFakes();

      await expect(
        prepareChat({
          store,
          prompts,
          mode: "public",
          messages,
          rewriteQuery: async () => {
            throw new Error("boom");
          },
        }),
      ).resolves.toBeDefined();
    });
  });
});
