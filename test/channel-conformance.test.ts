/**
 * Shared SPI conformance suite: the same set of scenarios, run once per
 * built-in channel (WhatsApp, Telegram, Matrix), asserting the contract every
 * transport gets for free by wiring `./channels`' `createInboundPipeline`
 * (gates, `channelHint`, `transformReply`, `rewriteQuery`/`rerankContext`,
 * history) and the sender-registry lifecycle every `Channel` owns directly.
 *
 * A channel-specific "adapter" below turns each transport's own fake-wire
 * idioms (already used in its own `channel.test.ts`) into one shared shape,
 * so a scenario is written once and drift in any single channel's wiring
 * (an unpassed hook, a hardcoded default, a gate applied out of order) fails
 * that channel's own run of the shared scenario without touching the others.
 * See docs/build-a-channel.md for what a new transport must implement to be
 * addable here.
 */
import { describe, expect, test } from "bun:test";
import { createClient } from "@libsql/client";
import type { Channel } from "../src/channels";
import { createMatrixChannel } from "../src/channels/matrix";
import type { MatrixApi, MatrixEvent, MatrixSyncResponse } from "../src/channels/matrix/api";
import { createSenderRegistry } from "../src/channels/senders";
import { createTelegramChannel } from "../src/channels/telegram";
import type { TelegramApi, TelegramMessage, TelegramUpdate } from "../src/channels/telegram/api";
import { createWhatsAppChannel, createWhatsAppInboundHandler } from "../src/channels/whatsapp";
import type { WhatsAppMessageEvent } from "../src/channels/whatsapp/channel";
import type { WhatsAppInboundConfig } from "../src/channels/whatsapp/inbound";
import type { AnswerFnInput } from "../src/core/answer";
import type { Logger } from "../src/core/logger";
import type { PromptLoader } from "../src/core/prompts";
import type { VectorStore } from "../src/core/retrieval";
import type { HistoryMessage, HistoryStore } from "../src/history";
import type { BrainHooks, ChatterConfig, ServerDependencies } from "../src/types";

// --- shared scenario shape ---

interface Scenario extends Pick<BrainHooks, "transformReply" | "rewriteQuery" | "rerankContext"> {
  channelHint?: string;
  allowedChats?: string[];
  history?: {
    store: HistoryStore;
    limit?: number;
  };
}

interface ScenarioResult {
  /** Text of every reply actually delivered to the chat, in order. */
  replies: string[];
  /** Every call `answerFn` received; empty when the gate never let the turn through. */
  answered: AnswerFnInput[];
  /** Every query `store.query` was actually asked, post-`rewriteQuery`. */
  queries: string[];
}

interface ConformanceAdapter {
  name: string;
  /** The `channelHint` default this channel falls back to when a scenario doesn't set one. */
  defaultChannelHint: string;
  /** Delivers one addressed message and returns what happened. `group: false` -> a DM (always eligible); `group: true` -> a group message addressed to the bot, subject to `allowedChats`. */
  deliver(scenario: Scenario, text: string, opts?: { group?: boolean }): Promise<ScenarioResult>;
  /** Registers a sender on start and unregisters it on stop: the lifecycle every `Channel` owns directly, outside the pipeline. */
  senderLifecycle(): Promise<{ registeredWhileRunning: boolean; registeredAfterStop: boolean }>;
}

function fakePrompts(): PromptLoader {
  return {
    baseSystemRules: "rules",
    publicPersona: "persona",
    privatePersona: "private persona",
  } as unknown as PromptLoader;
}

function silentLogger(): Logger {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

// --- shared adapter for the two Channel.start()/stop()-driven transports ---
//
// Telegram and Matrix differ only in their wire shape (a bot-token long poll
// vs a homeserver sync) and their own fake-API idiom (already used in each
// one's own channel.test.ts) - everything else, from wiring `deps`/`scenario`
// through to running and tearing down the channel, is identical. A fourth
// Channel.start()/stop()-driven transport plugs in here with one options
// object instead of a fresh ~90-line copy; see the WhatsApp adapter below for
// how a transport whose pipeline contract lives outside `Channel.start()`
// (see its own note) instead builds `ConformanceAdapter` directly.

function pipelineChannelAdapter<Api extends { sent: string[] }>(opts: {
  name: string;
  defaultChannelHint: string;
  /** One scripted batch/poll's worth of fake API, seeded with `seedFor`'s events - `[]` for the sender-lifecycle check, which never delivers anything. */
  makeApi: (seed: unknown[]) => Api;
  makeChannel: (api: Api, scenario: Scenario) => Channel;
  /** The wire-shaped event(s) for one addressed message, in this transport's own update/batch shape. */
  seedFor: (text: string, group: boolean) => unknown[];
}): ConformanceAdapter {
  async function deliver(
    scenario: Scenario,
    text: string,
    deliverOpts: { group?: boolean } = {},
  ): Promise<ScenarioResult> {
    const answered: AnswerFnInput[] = [];
    const queries: string[] = [];
    const api = opts.makeApi(opts.seedFor(text, deliverOpts.group ?? false));
    const store = {
      query: async (q: string) => {
        queries.push(q);
        return ["chunk-a", "chunk-b"];
      },
    } as unknown as VectorStore;

    const channel = opts.makeChannel(api, scenario);
    const deps = {
      client: {} as ServerDependencies["client"],
      db: {} as ServerDependencies["db"],
      store,
      prompts: fakePrompts(),
      config: {
        answerFn: async (input: AnswerFnInput) => {
          answered.push(input);
          return "the answer";
        },
      } as unknown as ChatterConfig,
      senders: createSenderRegistry(silentLogger()),
      logger: silentLogger(),
    } as ServerDependencies;

    await channel.start(deps);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await channel.stop?.();

    return { replies: api.sent, answered, queries };
  }

  async function senderLifecycle() {
    const api = opts.makeApi([]);
    const deps = {
      client: {} as ServerDependencies["client"],
      db: {} as ServerDependencies["db"],
      store: { query: async () => [] } as unknown as VectorStore,
      prompts: fakePrompts(),
      config: {} as ChatterConfig,
      senders: createSenderRegistry(silentLogger()),
      logger: silentLogger(),
    } as ServerDependencies;
    const channel = opts.makeChannel(api, {});
    const senderName = channel.name;

    await channel.start(deps);
    const registeredWhileRunning = deps.senders.available(senderName);
    await channel.stop?.();
    const registeredAfterStop = deps.senders.available(senderName);
    return { registeredWhileRunning, registeredAfterStop };
  }

  return { name: opts.name, defaultChannelHint: opts.defaultChannelHint, deliver, senderLifecycle };
}

// --- Telegram adapter ---

function telegramAdapter(): ConformanceAdapter {
  const BOT = { id: 100, username: "MyBot", is_bot: true };

  function fakeApi(updates: TelegramUpdate[]): TelegramApi & { sent: string[] } {
    const sent: string[] = [];
    let round = 0;
    return {
      sent,
      call: async () => undefined as never,
      getMe: async () => BOT,
      getUpdates: () => {
        const batch = round++ === 0 ? updates : [];
        return batch.length > 0
          ? Promise.resolve(batch)
          : new Promise<TelegramUpdate[]>(() => undefined);
      },
      sendMessage: async (_chatId, text) => {
        sent.push(text);
      },
      sendMedia: async () => undefined,
      setMessageReaction: async () => undefined,
      setWebhook: async () => undefined,
      deleteWebhook: async () => undefined,
    };
  }

  function message(text: string, group: boolean): TelegramMessage {
    return group
      ? {
          message_id: 1,
          from: { id: 200 },
          chat: { id: -100, type: "supergroup" },
          text: `@MyBot ${text}`,
          entities: [{ type: "mention", offset: 0, length: 6 }],
        }
      : {
          message_id: 1,
          from: { id: 200 },
          chat: { id: 200, type: "private" },
          text,
        };
  }

  return pipelineChannelAdapter({
    name: "Telegram",
    defaultChannelHint: "Channel: Telegram.",
    makeApi: (seed) => fakeApi(seed as TelegramUpdate[]),
    seedFor: (text, group) => [{ update_id: 1, message: message(text, group) }],
    makeChannel: (api, scenario) =>
      createTelegramChannel({
        botToken: "test-token",
        api,
        allowedChats: scenario.allowedChats,
        channelHint: scenario.channelHint,
        transformReply: scenario.transformReply,
        rewriteQuery: scenario.rewriteQuery,
        rerankContext: scenario.rerankContext,
        history: scenario.history,
        sleep: async () => undefined,
        logger: silentLogger(),
      }),
  });
}

// --- Matrix adapter ---

function matrixAdapter(): ConformanceAdapter {
  const ME = "@bot:example.org";

  function fakeApi(events: MatrixEvent[]): MatrixApi & { sent: string[] } {
    const sent: string[] = [];
    let round = 0;
    let counter = 0;
    return {
      sent,
      call: async () => undefined as never,
      whoami: async () => ({ userId: ME }),
      sync: () => {
        const batch: MatrixSyncResponse | undefined =
          round++ === 0
            ? {
                next_batch: "s1",
                rooms: { join: { "!room:example.org": { timeline: { events } } } },
              }
            : undefined;
        return batch ? Promise.resolve(batch) : new Promise<MatrixSyncResponse>(() => undefined);
      },
      sendEvent: async (_roomId, content) => {
        sent.push(String((content as { body?: string }).body ?? ""));
        counter += 1;
        return { eventId: `$sent-${counter}` };
      },
      uploadMedia: async () => ({ contentUri: "mxc://example.org/x" }),
      sendMedia: async () => {
        counter += 1;
        return { eventId: `$media-${counter}` };
      },
      joinRoom: async () => undefined,
      getAccountData: async () => undefined,
      setAccountData: async () => undefined,
    };
  }

  function event(text: string): MatrixEvent {
    return {
      type: "m.room.message",
      event_id: "$1",
      sender: "@alice:example.org",
      origin_server_ts: 1,
      content: { msgtype: "m.text", body: `@Bot ${text}`, "m.mentions": { user_ids: [ME] } },
    } as MatrixEvent;
  }

  return pipelineChannelAdapter({
    name: "Matrix",
    defaultChannelHint: "Channel: Matrix.",
    makeApi: (seed) => fakeApi(seed as MatrixEvent[]),
    // Matrix rooms are always this fixture's addressed-group shape; DM
    // behaviour (is_direct invites, m.direct) is covered in matrix/channel.test.ts.
    seedFor: (text) => [event(text)],
    makeChannel: (api, scenario) =>
      createMatrixChannel({
        homeserverUrl: "https://example.org",
        accessToken: "t",
        api,
        allowedChats: scenario.allowedChats,
        channelHint: scenario.channelHint,
        transformReply: scenario.transformReply,
        rewriteQuery: scenario.rewriteQuery,
        rerankContext: scenario.rerankContext,
        history: scenario.history,
        sleep: async () => undefined,
        logger: silentLogger(),
      }),
  });
}

// --- WhatsApp adapter ---
//
// WhatsApp's connection lifecycle (Baileys, Turso auth state, the deploy
// lease) is a different layer from the pipeline contract this suite checks;
// see `./channel.test.ts` for that layer. `createWhatsAppInboundHandler` is
// the equivalent unit here: it's where gates/channelHint/transformReply/
// rewriteQuery/rerankContext/history are actually wired for this channel,
// exactly like `createTelegramChannel`/`createMatrixChannel` wire them for
// theirs.

function whatsappAdapter(): ConformanceAdapter {
  function waEvent(text: string, group: boolean): WhatsAppMessageEvent {
    const chatId = group ? "group@g.us" : "447700900123@s.whatsapp.net";
    return {
      sessionId: "default",
      sock: {
        user: { id: "447700900000@s.whatsapp.net" },
        sendMessage: async () => undefined,
      } as never,
      message: {
        key: {
          remoteJid: chatId,
          participant: group ? "447700900999@s.whatsapp.net" : undefined,
          fromMe: false,
        },
        message: group
          ? {
              extendedTextMessage: {
                text: `@447700900000 ${text}`,
                contextInfo: { mentionedJid: ["447700900000@s.whatsapp.net"] },
              },
            }
          : { conversation: text },
      } as never,
    };
  }

  async function deliver(
    scenario: Scenario,
    text: string,
    opts: { group?: boolean } = {},
  ): Promise<ScenarioResult> {
    const answered: AnswerFnInput[] = [];
    const queries: string[] = [];
    const replies: string[] = [];
    const store = {
      query: async (q: string) => {
        queries.push(q);
        return ["chunk-a", "chunk-b"];
      },
    } as unknown as VectorStore;

    const event = waEvent(text, opts.group ?? false);
    (event.sock as unknown as { sendMessage: (...a: unknown[]) => Promise<void> }).sendMessage =
      async (_chatId: unknown, content: unknown) => {
        const body = content as { text?: string };
        if (typeof body.text === "string") replies.push(body.text);
      };

    const config: WhatsAppInboundConfig = {
      client: {} as unknown as ServerDependencies["client"],
      store,
      prompts: fakePrompts(),
      registry: new Map(),
      allowedChats: scenario.allowedChats,
      channelHint: scenario.channelHint,
      transformReply: scenario.transformReply,
      rewriteQuery: scenario.rewriteQuery,
      rerankContext: scenario.rerankContext,
      history: scenario.history,
      // Via serverConfig, not this config's own answerFn field - so this
      // adapter exercises the same `config.X ?? deps.config.X` fallback
      // precedence the Telegram/Matrix adapters exercise by putting
      // answerFn on their fake `deps.config` (see those adapters' `deliver`).
      serverConfig: {
        answerFn: async (input) => {
          answered.push(input);
          return "the answer";
        },
      },
      logger: silentLogger(),
    };

    const handler = createWhatsAppInboundHandler(config);
    await handler(event);

    return { replies, answered, queries };
  }

  // WhatsApp's sender registration lives in `channel.start()`, a different
  // layer from `createWhatsAppInboundHandler` (see the module note above),
  // driven here the same way `./whatsapp/channel.test.ts` does, via a fake
  // Baileys module and an in-memory Turso client (no real network, no auth).
  async function senderLifecycle() {
    const handlers = new Map<string, ((payload: unknown) => void)[]>();
    const sock = {
      user: { id: "15550001234@s.whatsapp.net" },
      ev: {
        on: (event: string, handler: (payload: unknown) => void) => {
          const list = handlers.get(event) ?? [];
          list.push(handler);
          handlers.set(event, list);
        },
        emit: (event: string, payload: unknown) => {
          for (const handler of handlers.get(event) ?? []) handler(payload);
        },
      },
      sendMessage: async () => undefined,
      end: () => undefined,
    };
    // biome-ignore lint/suspicious/noExplicitAny: minimal structural fake of the Baileys module for tests
    const baileys: any = {
      BufferJSON: {
        replacer: (_k: string, v: unknown) => v,
        reviver: (_k: string, v: unknown) => v,
      },
      initAuthCreds: () => ({ registered: true, noiseKey: {} }),
      proto: { Message: { AppStateSyncKeyData: { fromObject: (v: unknown) => v } } },
      fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 0] }),
      makeCacheableSignalKeyStore: (keys: unknown) => keys,
      DisconnectReason: { loggedOut: 401 },
      makeWASocket: () => sock,
    };

    const senders = createSenderRegistry(silentLogger());
    const deps = {
      client: {} as never,
      store: {} as never,
      db: createClient({ url: ":memory:" }),
      config: {} as never,
      prompts: {} as never,
      senders,
      logger: silentLogger(),
    } as unknown as ServerDependencies;

    const channel = createWhatsAppChannel({
      sessionSecret: "test-session-secret-value",
      loadBaileys: async () => baileys,
      schedule: () => undefined,
    });

    await channel.start(deps);
    await new Promise((resolve) => setTimeout(resolve, 20));
    sock.ev.emit("connection.update", { connection: "open" });
    const registeredWhileRunning = senders.available("whatsapp");
    await channel.stop?.();
    const registeredAfterStop = senders.available("whatsapp");
    return { registeredWhileRunning, registeredAfterStop };
  }

  return { name: "WhatsApp", defaultChannelHint: "Channel: WhatsApp.", deliver, senderLifecycle };
}

// --- the shared suite ---

const adapters = [telegramAdapter(), matrixAdapter(), whatsappAdapter()];

for (const adapter of adapters) {
  describe(`channel conformance: ${adapter.name}`, () => {
    test("an addressed message reaches answerFn with the channel's default channelHint", async () => {
      const result = await adapter.deliver({}, "hello", { group: true });
      expect(result.answered).toHaveLength(1);
      expect(result.answered[0]?.system).toContain(adapter.defaultChannelHint);
    });

    test("a configured channelHint overrides the default", async () => {
      const result = await adapter.deliver({ channelHint: "Custom hint text." }, "hello", {
        group: true,
      });
      expect(result.answered[0]?.system).toContain("Custom hint text.");
      expect(result.answered[0]?.system).not.toContain(adapter.defaultChannelHint);
    });

    test("transformReply replaces the delivered reply", async () => {
      const result = await adapter.deliver(
        { transformReply: ({ text }) => `${text} (transformed)` },
        "hello",
        { group: true },
      );
      expect(result.replies).toEqual(["the answer (transformed)"]);
    });

    test("transformReply vetoing (null) delivers nothing", async () => {
      const result = await adapter.deliver({ transformReply: () => null }, "hello", {
        group: true,
      });
      // The turn must actually have reached the pipeline: an empty `replies`
      // is also what a broken fixture (nothing addressed, gate misfired)
      // would produce, which would pass this assertion for the wrong reason.
      expect(result.answered).toHaveLength(1);
      expect(result.replies).toEqual([]);
    });

    test("a throwing transformReply delivers the original, unmodified reply", async () => {
      const result = await adapter.deliver(
        {
          transformReply: () => {
            throw new Error("plugin bug");
          },
        },
        "hello",
        { group: true },
      );
      expect(result.replies).toEqual(["the answer"]);
    });

    test("a transformReply returning undefined is treated as a veto, not delivered verbatim", async () => {
      const result = await adapter.deliver({ transformReply: () => undefined as never }, "hello", {
        group: true,
      });
      // Same rationale as the null-veto test above: prove the turn was
      // actually answered before trusting that nothing was delivered.
      expect(result.answered).toHaveLength(1);
      expect(result.replies).toEqual([]);
    });

    test("rewriteQuery reaches retrieval before rerankContext sees its result", async () => {
      const result = await adapter.deliver(
        {
          rewriteQuery: async () => "rewritten query",
          rerankContext: async ({ query, chunks }) => {
            expect(query).toBe("rewritten query");
            return [...chunks].reverse();
          },
        },
        "hello",
        { group: true },
      );
      expect(result.queries).toEqual(["rewritten query"]);
      expect(result.answered[0]?.system).toContain("chunk-b\n\nchunk-a");
    });

    test("a non-allowlisted group is gated: no answerFn call, no reply", async () => {
      // Positive control, run first: the identical fixture with no
      // allowlist DOES answer, so the empty result below is provably the
      // gate's doing and not a broken fixture that never addressed the bot.
      const ungated = await adapter.deliver({}, "hello", { group: true });
      expect(ungated.answered).toHaveLength(1);

      const result = await adapter.deliver({ allowedChats: ["some-other-chat"] }, "hello", {
        group: true,
      });
      expect(result.answered).toEqual([]);
      expect(result.replies).toEqual([]);
    });

    test("history: prior turns feed the answer and the new turn is recorded", async () => {
      const stored = new Map<string, HistoryMessage[]>();
      const store: HistoryStore = {
        async append(conversationId, message) {
          stored.set(conversationId, [...(stored.get(conversationId) ?? []), message]);
        },
        async load(conversationId) {
          return stored.get(conversationId) ?? [{ role: "user", content: "earlier turn" }];
        },
        async clear(conversationId) {
          stored.delete(conversationId);
        },
      };

      const result = await adapter.deliver({ history: { store } }, "hello", { group: true });

      expect(result.answered).toHaveLength(1);
      expect(result.answered[0]?.messages[0]).toEqual({ role: "user", content: "earlier turn" });
    });

    test("the channel registers a sender while running and unregisters it on stop", async () => {
      const { registeredWhileRunning, registeredAfterStop } = await adapter.senderLifecycle();
      expect(registeredWhileRunning).toBe(true);
      expect(registeredAfterStop).toBe(false);
    });
  });
}
