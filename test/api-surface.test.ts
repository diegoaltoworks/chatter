/**
 * Locks the downstream consumption patterns documented in docs/server.md,
 * docs/channels.md, docs/telegram.md, docs/personas.md, docs/flows.md,
 * docs/history.md, docs/build-a-channel.md and docs/integrations.md: the shape of
 * ServerDependencies (incl. the shared db handle), starting a Channel
 * standalone, personaResolver output feeding prepareChat's personaLayer, the
 * bucketsFor retrieval hook, the rewriteQuery/rerankContext retrieval seams,
 * prepareChat's channel-facing params, the answerFn brain hook, the
 * transformReply outbound hook, sending through the
 * sender registry by name, the flow contract a plugin implements, a
 * HistoryStore's loaded turns feeding straight into that same messages
 * array, the channel-agnostic inbound pipeline a new transport builds on,
 * and the OpenAI-compatible wire shape third-party clients depend on.
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
import type {
  AnswerFn,
  BrainHooks,
  BucketsFor,
  Channel,
  Embedder,
  Logger,
  PipelineMessage,
  RerankContext,
  Retriever,
  RewriteQuery,
  ServerDependencies,
  TransformReply,
} from "../src";
import {
  createConsoleLogger,
  createOpenAIEmbedder,
  prepareChat,
  resolveBuckets,
  VectorStore,
} from "../src";
import {
  type ChannelMessage,
  createInboundPipeline,
  createSenderRegistry,
  type InboundReplySender,
  resolveBrainHooks,
} from "../src/channels";
import type { MatrixChannelConfig } from "../src/channels/matrix";
import {
  createMatrixChannel,
  toChannelMessage as toMatrixChannelMessage,
} from "../src/channels/matrix";
import type { TelegramChannelConfig, TelegramUpdate } from "../src/channels/telegram";
import { createTelegramChannel, toChannelMessage } from "../src/channels/telegram";
import type { FlowHandler, FlowHandlerContext, FlowHandlerResult, LoadedFlow } from "../src/flows";
import type { HistoryMessage, HistoryStore } from "../src/history";
import { createHistoryCompactor } from "../src/history";
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
    logger: createConsoleLogger(),
  };
}

describe("API surface", () => {
  test("ServerDependencies is constructible with a db field alongside client/store/senders", () => {
    const deps = fakeDeps();
    expect(deps.senders.available("anything")).toBe(false);
    expect(deps.db).toBeDefined();
  });

  test("ServerDependencies.store is the Retriever interface, satisfiable by a plain object literal", () => {
    const retriever: Retriever = {
      query: async (_query, _k, allowedBuckets) => allowedBuckets,
    };
    const deps: ServerDependencies = { ...fakeDeps(), store: retriever };
    expect(deps.store).toBe(retriever);
  });

  test("ChatterConfig.retriever accepts the same Retriever shape", () => {
    const retriever: Retriever = {
      build: async () => {},
      query: async () => [],
    };
    const config: Pick<ChatterConfig, "retriever"> = { retriever };
    expect(config.retriever).toBe(retriever);
  });

  test("VectorStore takes an injected Embedder and an existing libsql client (docs/server.md's snippet)", () => {
    const embed: Embedder = async (input) => input.map(() => [0]);
    const db = {} as ServerDependencies["db"];
    const store = new VectorStore(createOpenAIEmbedder({} as never), { databaseClient: db });
    const custom = new VectorStore(embed, { databaseClient: db, knowledgeDir: "./knowledge" });

    expect(store.db).toBe(db);
    expect(custom.db).toBe(db);
  });

  test("ServerDependencies.logger is a leveled Logger, satisfiable by a custom implementation", () => {
    const deps = fakeDeps();
    expect(typeof deps.logger.debug).toBe("function");
    expect(typeof deps.logger.info).toBe("function");
    expect(typeof deps.logger.warn).toBe("function");
    expect(typeof deps.logger.error).toBe("function");

    const calls: string[] = [];
    const custom: Logger = {
      debug: (...a) => calls.push(String(a[0])),
      info: (...a) => calls.push(String(a[0])),
      warn: (...a) => calls.push(String(a[0])),
      error: (...a) => calls.push(String(a[0])),
    };
    const deps2: ServerDependencies = { ...deps, logger: custom };
    deps2.logger.info("hello");
    expect(calls).toEqual(["hello"]);
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

  // The built-in second transport, and the proof that the SPI above is
  // implementable from outside `./channels`: `./telegram` is configured with
  // nothing but a bot token, satisfies `Channel`, and takes the same
  // answerFn/bucketsFor/history seams every other surface does.
  test("the Telegram channel is a Channel configured from a bot token alone", async () => {
    const config: TelegramChannelConfig = {
      botToken: "token",
      allowedChats: ["-100"],
      answerFn: async () => "answer",
      bucketsFor: async () => ["support"],
      channelHint: "Replies are delivered over Telegram.",
      history: {
        store: { append: async () => {}, load: async () => [], clear: async () => {} },
        limit: 10,
        historyEnabledFor: () => true,
      },
    };
    const channel: Channel = createTelegramChannel(config);
    expect(channel.name).toBe("telegram");
    expect(typeof channel.stop).toBe("function");

    // The wire types are exported too, so a host can pre-map its own updates
    // (a webhook handler, say) into the same ChannelMessage shape.
    const update: TelegramUpdate = {
      update_id: 1,
      message: {
        message_id: 7,
        from: { id: 200 },
        chat: { id: 200, type: "private" },
        text: "hi",
      },
    };
    const msg: ChannelMessage | undefined = toChannelMessage(update, { id: 100, username: "bot" });
    expect(msg?.messageRef).toBe(7);
  });

  // The third built-in transport, and proof the SPI works with zero peer
  // dependencies: `./matrix` is configured with a homeserver URL and access
  // token alone, satisfies `Channel`, and takes the same seams every other
  // surface does.
  test("the Matrix channel is a Channel configured from a homeserver URL and access token alone", async () => {
    const config: MatrixChannelConfig = {
      homeserverUrl: "https://matrix.example.org",
      accessToken: "token",
      allowedChats: ["!room:example.org"],
      answerFn: async () => "answer",
      bucketsFor: async () => ["support"],
      channelHint: "Replies are delivered over Matrix.",
      history: {
        store: { append: async () => {}, load: async () => [], clear: async () => {} },
        limit: 10,
        historyEnabledFor: () => true,
      },
    };
    const channel: Channel = createMatrixChannel(config);
    expect(channel.name).toBe("matrix");
    expect(typeof channel.stop).toBe("function");

    // The wire mapping is exported too, so a host can pre-map its own sync
    // events into the same ChannelMessage shape.
    const msg: ChannelMessage | undefined = toMatrixChannelMessage(
      "!room:example.org",
      {
        type: "m.room.message",
        event_id: "$1",
        sender: "@alice:example.org",
        origin_server_ts: 1,
        content: { msgtype: "m.text", body: "hi" },
      },
      { userId: "@bot:example.org" },
      new Set(),
      new Set(),
    );
    expect(msg?.chatId).toBe("!room:example.org");
  });

  // Compaction is optional history layering, built entirely on HistoryStore's
  // own append/load/clear: this locks that it composes with any store, not
  // just the shipped Turso one.
  test("createHistoryCompactor folds turns beyond threshold via any HistoryStore", async () => {
    const client = {
      chat: {
        completions: {
          create: async () => ({ choices: [{ message: { content: "a summary" } }] }),
        },
      },
    } as unknown as ServerDependencies["client"];

    function fakeStore(turns: HistoryMessage[]) {
      const cleared: string[] = [];
      const appended: HistoryMessage[] = [];
      const store: HistoryStore = {
        async append(_conversationId, message) {
          appended.push(message);
        },
        async load() {
          return turns;
        },
        async clear(conversationId) {
          cleared.push(conversationId);
        },
      };
      return { store, cleared, appended };
    }

    const compactor = createHistoryCompactor({ client }, { threshold: 3, keep: 1 });

    // Below threshold: left untouched.
    const below = fakeStore([
      { role: "user", content: "one" },
      { role: "assistant", content: "two" },
    ]);
    await compactor.maybeCompact(below.store, "conv-1");
    expect(below.cleared).toEqual([]);
    expect(below.appended).toEqual([]);

    // At threshold: cleared, then the summary plus the kept turn re-appended
    // (SUMMARY_PREFIX is `createHistoryCompactor`'s own marker for a folded
    // turn, not asserted verbatim here since it isn't part of this contract).
    const at = fakeStore([
      { role: "user", content: "one" },
      { role: "assistant", content: "two" },
      { role: "user", content: "three" },
    ]);
    await compactor.maybeCompact(at.store, "conv-1");
    expect(at.cleared).toEqual(["conv-1"]);
    expect(at.appended).toHaveLength(2);
    expect(at.appended[0]?.content).toContain("a summary");
    expect(at.appended[1]).toEqual({ role: "user", content: "three" });
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
  // system/messages/mode/sender/conversationId fields a downstream brain can
  // rely on.
  test("the answerFn brain hook is called with system/messages/mode/sender/conversationId", async () => {
    const answerFn: AnswerFn = async ({ system, messages, mode, sender, conversationId }) => {
      expect(typeof system).toBe("string");
      expect(Array.isArray(messages)).toBe(true);
      expect(mode === "public" || mode === "private").toBe(true);
      expect(sender === undefined || typeof sender === "string").toBe(true);
      expect(conversationId === undefined || typeof conversationId === "string").toBe(true);
      return "answer";
    };

    const result = await answerFn({
      system: "sys",
      messages: [],
      mode: "public",
      conversationId: "conv-1",
    });
    expect(result).toBe("answer");
  });

  // Locks docs/build-a-channel.md's "From sketch to shipped channel" example,
  // which builds a config from BrainHooks and resolves it against the
  // server's own via resolveBrainHooks instead of five hand-rolled `??`s.
  test("a channel config built from BrainHooks resolves against the server's via resolveBrainHooks", () => {
    const config: BrainHooks & { channelHint?: string } = {
      answerFn: async () => "from config",
      channelHint: "Custom hint.",
    };
    const serverConfig: BrainHooks = {
      answerFn: async () => "from server",
      bucketsFor: async () => ["support"],
    };

    const resolved = resolveBrainHooks(config, serverConfig);

    expect(resolved.answerFn).toBe(config.answerFn);
    expect(resolved.bucketsFor).toBe(serverConfig.bucketsFor);
    expect(resolved.rewriteQuery).toBeUndefined();
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

  test("sendReaction targets a ChannelMessage's messageRef through the sender registry", async () => {
    const registry = createSenderRegistry();
    const reactions: Array<{ chatId: string; messageRef: unknown; emoji: string }> = [];
    registry.register("example", {
      sendText: async () => {},
      sendReaction: async (chatId: string, messageRef: unknown, emoji: string) => {
        reactions.push({ chatId, messageRef, emoji });
      },
    });

    const msg: ChannelMessage = {
      chatId: "chat-1",
      senderId: "user-1",
      text: "hi",
      isDirectMessage: true,
      mentionsBot: false,
      isReplyToBot: false,
      fromBot: false,
      messageRef: { id: "wamid.abc" },
    };

    expect(await registry.sendReaction("example", msg.chatId, msg.messageRef, "👍")).toBe(true);
    expect(reactions).toEqual([{ chatId: "chat-1", messageRef: { id: "wamid.abc" }, emoji: "👍" }]);
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

  test("rewriteQuery and rerankContext shape retrieval without touching prepareChat's other params", async () => {
    const store = {
      query: async (q: string, _k: number, _buckets: string[]) => {
        expect(q).toBe("rewritten query");
        return ["a", "b"];
      },
    } as unknown as ServerDependencies["store"];
    const prompts = {
      baseSystemRules: "rules",
      publicPersona: "persona",
      privatePersona: "private persona",
    } as unknown as ServerDependencies["prompts"];

    const seenRewrite: Array<{ query: string; mode: string; sender?: string }> = [];
    const rewriteQuery: RewriteQuery = async (ctx) => {
      seenRewrite.push(ctx);
      return "rewritten query";
    };
    const seenRerank: Array<{ query: string; chunks: string[] }> = [];
    const rerankContext: RerankContext = async (ctx) => {
      seenRerank.push(ctx);
      return [...ctx.chunks].reverse();
    };

    const { context } = await prepareChat({
      store,
      prompts,
      mode: "public",
      messages: [{ role: "user", content: "original query" }],
      sender: "user-1",
      rewriteQuery,
      rerankContext,
    });

    expect(seenRewrite).toEqual([{ query: "original query", mode: "public", sender: "user-1" }]);
    expect(seenRerank).toEqual([{ query: "rewritten query", chunks: ["a", "b"] }]);
    expect(context).toEqual(["b", "a"]);
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

  // Guards the WhatsApp history wiring's `[...priorTurns, newTurn]` spread:
  // if PipelineMessage ever grows an incompatible field, the assignment below
  // fails to typecheck here rather than surfacing downstream.
  test("a HistoryStore's loaded turns feed directly into prepareChat/answerOnce's messages array", async () => {
    const turns: HistoryMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    const asPipelineMessages: PipelineMessage[] = turns;
    expect(asPipelineMessages).toEqual(turns);

    const appended: Array<{ conversationId: string; message: HistoryMessage }> = [];
    const cleared: string[] = [];
    const store: HistoryStore = {
      async append(conversationId, message) {
        appended.push({ conversationId, message });
      },
      async load() {
        return turns;
      },
      async clear(conversationId) {
        cleared.push(conversationId);
      },
    };

    expect(await store.load("conv-1", 10)).toEqual(turns);
    await store.append("conv-1", { role: "user", content: "again" });
    expect(appended).toEqual([
      { conversationId: "conv-1", message: { role: "user", content: "again" } },
    ]);

    // The reset primitive a host wires into a "forget me" detector — see
    // docs/history.md's privacy section.
    await store.clear("conv-1");
    expect(cleared).toEqual(["conv-1"]);
  });

  test("createInboundPipeline (a new channel's foundation) answers a ChannelMessage through an InboundReplySender", async () => {
    const store = { query: async () => ["context"] } as unknown as ServerDependencies["store"];
    const prompts = {
      baseSystemRules: "rules",
      publicPersona: "persona",
      privatePersona: "private persona",
    } as unknown as ServerDependencies["prompts"];

    const handle = createInboundPipeline(
      { client: {} as ServerDependencies["client"], store, prompts },
      { channel: "test-channel", answerFn: async () => "hello from the pipeline" },
    );

    const delivered: Array<{ chatId: string; text: string }> = [];
    const reply: InboundReplySender = {
      sendAnswer: async (chatId, text) => {
        delivered.push({ chatId, text });
      },
      sendGateReply: async () => undefined,
    };
    const msg: ChannelMessage = {
      chatId: "chat-1",
      senderId: "user-1",
      text: "hi",
      isDirectMessage: true,
      mentionsBot: false,
      isReplyToBot: false,
      fromBot: false,
    };

    const outcome = await handle(msg, { reply, sender: "user-1", conversationId: "chat-1" });

    expect(outcome).toEqual({ action: "reply", content: "hello from the pipeline" });
    expect(delivered).toEqual([{ chatId: "chat-1", text: "hello from the pipeline" }]);
  });

  test("ChatterConfig.transformReply modifies a reply the channel pipeline already produced", async () => {
    const store = { query: async () => ["context"] } as unknown as ServerDependencies["store"];
    const prompts = {
      baseSystemRules: "rules",
      publicPersona: "persona",
      privatePersona: "private persona",
    } as unknown as ServerDependencies["prompts"];

    const transformReply: TransformReply = ({ text }) => `${text} (transformed)`;

    const handle = createInboundPipeline(
      { client: {} as ServerDependencies["client"], store, prompts },
      { channel: "test-channel", answerFn: async () => "hello", transformReply },
    );

    const delivered: Array<{ chatId: string; text: string }> = [];
    const reply: InboundReplySender = {
      sendAnswer: async (chatId, text) => {
        delivered.push({ chatId, text });
      },
      sendGateReply: async () => undefined,
    };
    const msg: ChannelMessage = {
      chatId: "chat-1",
      senderId: "user-1",
      text: "hi",
      isDirectMessage: true,
      mentionsBot: false,
      isReplyToBot: false,
      fromBot: false,
    };

    const outcome = await handle(msg, { reply, sender: "user-1", conversationId: "chat-1" });

    expect(outcome).toEqual({ action: "reply", content: "hello (transformed)" });
    expect(delivered).toEqual([{ chatId: "chat-1", text: "hello (transformed)" }]);
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
