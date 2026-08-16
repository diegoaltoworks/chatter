/**
 * Locks the downstream consumption patterns documented in docs/server.md,
 * docs/channels.md, docs/personas.md, docs/flows.md and docs/integrations.md:
 * the shape of ServerDependencies (incl. the shared db handle), starting a
 * Channel standalone, personaResolver output feeding prepareChat's
 * personaLayer, the bucketsFor retrieval hook, prepareChat's channel-facing
 * params, the answerFn brain hook, sending through the sender registry by
 * name, the flow contract a plugin implements, and the OpenAI-compatible wire
 * shape third-party clients depend on.
 *
 * Typechecked via test/tsconfig.json (see `bun run typecheck:api-surface`,
 * folded into `bun run check`) so a breaking change to any of these types
 * fails compilation here rather than downstream.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatCompletion } from "openai/resources/chat/completions";
import type { AnswerFn, BucketsFor, Channel, PipelineMessage, ServerDependencies } from "../src";
import { prepareChat, resolveBuckets } from "../src";
import { createSenderRegistry } from "../src/channels";
import type { FlowHandler, FlowHandlerContext, FlowHandlerResult, LoadedFlow } from "../src/flows";
import { createPersonaResolver } from "../src/personas";
import { openaiRoutes } from "../src/routes/openai";
import type { ChatterConfig } from "../src/types";

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

  test("bucketsFor is consulted with {mode, sender?} and its answer reaches resolveBuckets", async () => {
    const seen: Array<{ mode: string; sender?: string }> = [];
    const bucketsFor: BucketsFor = async (ctx) => {
      seen.push(ctx);
      return ["base", "vip"];
    };

    // An identified caller can be widened beyond the mode defaults...
    expect(await resolveBuckets({ mode: "public", sender: "user-1", bucketsFor })).toEqual([
      "base",
      "vip",
    ]);
    // ...an anonymous one is clamped back down to them - the security
    // invariant seam_rag_buckets exists to guarantee.
    expect(await resolveBuckets({ mode: "public", bucketsFor })).toEqual(["base"]);
    expect(seen).toEqual([{ mode: "public", sender: "user-1" }, { mode: "public" }]);
  });

  test("prepareChat's channel-facing params (personaLayer, channelHint, buckets) shape the system prompt", async () => {
    const store = {
      query: async (_q: string, _k: number, buckets: string[]) => {
        expect(buckets).toEqual(["support"]);
        return ["retrieved context"];
      },
    } as unknown as ServerDependencies["store"];
    const prompts = {
      baseSystemRules: "rules",
      publicPersona: "default persona - replaced when personaLayer is set",
      privatePersona: "private persona",
    } as unknown as ServerDependencies["prompts"];
    const messages: PipelineMessage[] = [{ role: "user", content: "hi" }];

    const { system } = await prepareChat({
      store,
      prompts,
      mode: "public",
      messages,
      personaLayer: "You are Riley, a WhatsApp concierge.",
      channelHint: "Replies are delivered over WhatsApp; keep them short.",
      buckets: ["support"],
    });

    expect(system).toBe(
      "rules\n\nYou are Riley, a WhatsApp concierge.\n\nReplies are delivered over WhatsApp; keep them short.\n\nContext:\nretrieved context",
    );
  });

  test("a flow directory's handler is a FlowHandler returning FlowHandlerResult, given a FlowHandlerContext", async () => {
    const handler: FlowHandler = async (params, context) => {
      expect(context.sessionKey).toBe("session-1");
      return { success: true, message: `booked for ${params.name}`, result: { id: 1 } };
    };

    const flow: Pick<LoadedFlow, "handler"> = { handler };
    const context: FlowHandlerContext = { sessionKey: "session-1", channel: "whatsapp" };

    const result: FlowHandlerResult = await flow.handler({ name: "Ana" }, context);
    expect(result).toEqual({ success: true, message: "booked for Ana", result: { id: 1 } });
  });

  test("POST /v1/chat/completions responds with the real OpenAI ChatCompletion wire shape", async () => {
    const client = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{ message: { content: "hi there" } }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        },
      },
    };
    const store = { query: async () => [] };
    const prompts = { baseSystemRules: "rules", publicPersona: "persona", privatePersona: "p" };
    const apiKeyManager = { verify: async () => ({ valid: true }) };
    const config: Pick<ChatterConfig, "bot" | "openai" | "database"> = {
      bot: { name: "Bot", personName: "Tester", publicUrl: "http://localhost", description: "t" },
      openai: { apiKey: "sk-test" },
      database: { url: "libsql://test", authToken: "" },
    };

    const deps = {
      client,
      store,
      prompts,
      apiKeyManager,
      config,
    } as unknown as ServerDependencies;

    const app = openaiRoutes(deps);
    const res = await app.fetch(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "valid" },
        body: JSON.stringify({ model: "ignored", messages: [{ role: "user", content: "hi" }] }),
      }),
    );

    expect(res.status).toBe(200);
    // Typed as the real SDK's response shape - a field the SDK renames or
    // drops fails compilation here, not silently in a downstream client.
    const body: ChatCompletion = await res.json();
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0].message.content).toBe("hi there");
    expect(body.choices[0].message.role).toBe("assistant");
    expect(body.usage?.total_tokens).toBe(2);
  });
});
