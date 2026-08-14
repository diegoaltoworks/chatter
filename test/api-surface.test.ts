/**
 * Locks the downstream consumption patterns documented in docs/server.md,
 * docs/channels.md, docs/personas.md and docs/integrations.md: the shape of
 * ServerDependencies (incl. the shared db handle), starting a Channel
 * standalone, personaResolver output feeding prepareChat's personaLayer, the
 * answerFn brain hook, and sending through the sender registry by name.
 *
 * Typechecked via test/tsconfig.json (see `bun run typecheck:api-surface`,
 * folded into `bun run check`) so a breaking change to any of these types
 * fails compilation here rather than downstream.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnswerFn, Channel, ServerDependencies } from "../src";
import { createSenderRegistry } from "../src/channels";
import { createPersonaResolver } from "../src/personas";

function fakeDeps(): ServerDependencies {
  return {
    client: {} as ServerDependencies["client"],
    store: {} as ServerDependencies["store"],
    db: {} as ServerDependencies["db"],
    config: {} as ServerDependencies["config"],
    prompts: {} as ServerDependencies["prompts"],
    senders: createSenderRegistry(),
  };
}

describe("API surface", () => {
  test("ServerDependencies is constructible with a db field alongside client/store/senders", () => {
    const deps = fakeDeps();
    expect(deps.senders.available("anything")).toBe(false);
    expect(deps.db).toBeDefined();
  });

  test("a Channel starts standalone with only ServerDependencies", async () => {
    const seenSenders: unknown[] = [];
    const channel: Channel = {
      name: "example",
      start: async (deps) => {
        seenSenders.push(deps.senders);
      },
    };

    const deps = fakeDeps();
    await channel.start(deps);
    expect(seenSenders).toEqual([deps.senders]);
  });

  test("personaResolver output feeds prepareChat's personaLayer directly", () => {
    const dir = mkdtempSync(join(tmpdir(), "api-surface-personas-"));
    try {
      writeFileSync(join(dir, "assistant.md"), "You are the assistant.", "utf-8");
      const resolver = createPersonaResolver({
        promptsDir: dir,
        registry: {
          defaultPersona: "assistant",
          personas: { assistant: { name: "Assistant", prompt: "assistant.md" } },
        },
      });

      // resolvePersonaLayer returns string | null; prepareChat's personaLayer
      // is string | undefined — `?? undefined` is the documented bridge.
      const personaLayer: string | undefined =
        resolver.resolvePersonaLayer("unknown-contact") ?? undefined;
      expect(personaLayer).toBe("You are the assistant.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Precedence over completeOnce/completeStream is covered by
  // src/core/answer.test.ts; this only locks the hook's shape — the
  // system/messages/mode/sender fields a downstream brain can rely on.
  test("the answerFn brain hook is called with system/messages/mode/sender", async () => {
    const answerFn: AnswerFn = async ({ system, messages, mode, sender }) => {
      expect(typeof system).toBe("string");
      expect(Array.isArray(messages)).toBe(true);
      expect(mode === "public" || mode === "private").toBe(true);
      expect(sender === undefined || typeof sender === "string").toBe(true);
      return "answer";
    };

    const result = await answerFn({ system: "sys", messages: [], mode: "public" });
    expect(result).toBe("answer");
  });

  test("the sender registry sends by channel name without importing the transport", async () => {
    const registry = createSenderRegistry();
    const sent: string[] = [];
    registry.register("example", {
      sendText: async (_chatId: string, text: string) => {
        sent.push(text);
      },
    });

    expect(await registry.sendText("example", "chat-1", "hi")).toBe(true);
    expect(sent).toEqual(["hi"]);
  });
});
