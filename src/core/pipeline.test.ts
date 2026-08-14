/**
 * Chat pipeline tests
 *
 * Uses faked prompts and vector store so prompt assembly can be asserted
 * without touching OpenAI or Turso.
 */

import { describe, expect, test } from "bun:test";
import { type PipelineMessage, prepareChat } from "./pipeline";
import type { PromptLoader } from "./prompts";
import type { VectorStore } from "./retrieval";

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
  } as unknown as VectorStore;

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
});
