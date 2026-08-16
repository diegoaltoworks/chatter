import { describe, expect, test } from "bun:test";
import type { AnswerFnInput } from "../core/answer";
import type { PromptLoader } from "../core/prompts";
import type { Retriever } from "../core/retrieval";
import type { HistoryMessage, HistoryStore } from "../history/types";
import type { ChannelMessage } from "./gates";
import {
  createInboundPipeline,
  type InboundPipelineConfig,
  type InboundReplySender,
  resolveBrainHooks,
} from "./pipeline";

describe("resolveBrainHooks", () => {
  test("a field set on config wins over the same field on fallback", () => {
    const configAnswerFn = async () => "from config";
    const fallbackAnswerFn = async () => "from fallback";
    const resolved = resolveBrainHooks(
      { answerFn: configAnswerFn },
      { answerFn: fallbackAnswerFn },
    );
    expect(resolved.answerFn).toBe(configAnswerFn);
  });

  test("a field unset on config falls back to the matching field on fallback", () => {
    const fallbackBucketsFor = async () => ["base"];
    const resolved = resolveBrainHooks({}, { bucketsFor: fallbackBucketsFor });
    expect(resolved.bucketsFor).toBe(fallbackBucketsFor);
  });

  test("a field unset on both, or with no fallback given, resolves to undefined", () => {
    expect(resolveBrainHooks({}, {})).toEqual({
      answerFn: undefined,
      bucketsFor: undefined,
      rewriteQuery: undefined,
      rerankContext: undefined,
      transformReply: undefined,
    });
    expect(resolveBrainHooks({}).answerFn).toBeUndefined();
  });

  test("resolves each of the five hooks independently", () => {
    const rewriteQuery = async () => "rewritten";
    const rerankContext = async () => ["chunk"];
    const transformReply = () => "transformed";
    const resolved = resolveBrainHooks({ rewriteQuery }, { rerankContext, transformReply });
    expect(resolved.rewriteQuery).toBe(rewriteQuery);
    expect(resolved.rerankContext).toBe(rerankContext);
    expect(resolved.transformReply).toBe(transformReply);
    expect(resolved.answerFn).toBeUndefined();
  });
});

function msg(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    chatId: "chat-1",
    senderId: "user-1",
    text: "hello",
    isDirectMessage: true,
    mentionsBot: false,
    isReplyToBot: false,
    fromBot: false,
    ...overrides,
  };
}

interface Harness {
  handle: ReturnType<typeof createInboundPipeline>;
  reply: InboundReplySender;
  answers: unknown[];
  gateReplies: Array<{ chatId: string; text: string }>;
  chatReplies: Array<{ chatId: string; text: string }>;
}

function harness(overrides: Partial<InboundPipelineConfig> = {}): Harness {
  const answers: unknown[] = [];
  const gateReplies: Array<{ chatId: string; text: string }> = [];
  const chatReplies: Array<{ chatId: string; text: string }> = [];

  const store = { query: async () => ["some context"] } satisfies Retriever;
  const prompts = {
    baseSystemRules: "rules",
    publicPersona: "persona",
    privatePersona: "private persona",
  } as unknown as PromptLoader;

  const reply: InboundReplySender = {
    sendAnswer: async (chatId, text) => {
      chatReplies.push({ chatId, text });
    },
    sendGateReply: async (chatId, text) => {
      gateReplies.push({ chatId, text });
    },
  };

  const handle = createInboundPipeline(
    { client: {} as never, store, prompts },
    {
      channel: "test-channel",
      answerFn: async (input) => {
        answers.push(input);
        return "a reply";
      },
      ...overrides,
    },
  );

  return { handle, reply, answers, gateReplies, chatReplies };
}

function fakeHistoryStore(): HistoryStore & { data: Map<string, HistoryMessage[]> } {
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

describe("createInboundPipeline", () => {
  test("a DM is answered through prepareChat/answerFn and delivered as an answer", async () => {
    const { handle, reply, answers, chatReplies } = harness();

    const outcome = await handle(msg(), { reply });

    expect(answers).toHaveLength(1);
    expect(outcome).toEqual({ action: "reply", content: "a reply" });
    expect(chatReplies).toEqual([{ chatId: "chat-1", text: "a reply" }]);
  });

  test("an unaddressed group message is ignored, no reply sent", async () => {
    const { handle, reply, answers, chatReplies } = harness();

    const outcome = await handle(msg({ isDirectMessage: false, mentionsBot: false }), { reply });

    expect(answers).toHaveLength(0);
    expect(chatReplies).toHaveLength(0);
    expect(outcome).toEqual({ action: "ignore" });
  });

  test("an addressed, allowlisted group message is answered", async () => {
    const { handle, reply, answers } = harness({ allowedChats: ["chat-1"] });

    await handle(msg({ isDirectMessage: false, mentionsBot: true, chatId: "chat-1" }), { reply });

    expect(answers).toHaveLength(1);
  });

  test("a non-allowlisted group is ignored even when addressed", async () => {
    const { handle, reply, answers } = harness({ allowedChats: ["other-chat"] });

    const outcome = await handle(
      msg({ isDirectMessage: false, mentionsBot: true, chatId: "chat-1" }),
      { reply },
    );

    expect(answers).toHaveLength(0);
    expect(outcome).toEqual({ action: "ignore" });
  });

  test("mute/unmute regexes flip the chat's mute state via sendGateReply, without answering", async () => {
    const { handle, reply, answers, gateReplies } = harness({
      muteRegex: /shut up/i,
      unmuteRegex: /wake up/i,
      muteReply: "ok",
      unmuteReply: "back",
    });
    const groupMsg = (text: string) =>
      msg({ isDirectMessage: false, mentionsBot: true, chatId: "group-1", text });

    const muted = await handle(groupMsg("shut up"), { reply });
    expect(muted).toEqual({ action: "mute" });
    expect(gateReplies).toEqual([{ chatId: "group-1", text: "ok" }]);

    // Muted now: an addressed message gets no reply at all.
    const stillMuted = await handle(groupMsg("you there"), { reply });
    expect(stillMuted).toEqual({ action: "ignore" });
    expect(answers).toHaveLength(0);

    const unmuted = await handle(groupMsg("wake up"), { reply });
    expect(unmuted).toEqual({ action: "unmute" });
    expect(gateReplies).toEqual([
      { chatId: "group-1", text: "ok" },
      { chatId: "group-1", text: "back" },
    ]);

    await handle(groupMsg("you there"), { reply });
    expect(answers).toHaveLength(1);
  });

  test("mute/unmute with no configured reply string flips state silently", async () => {
    const { handle, reply, gateReplies } = harness({ muteRegex: /shush/i });

    await handle(msg({ isDirectMessage: false, mentionsBot: true, text: "shush" }), { reply });

    expect(gateReplies).toHaveLength(0);
  });

  test("DM and group rate limits are tracked separately", async () => {
    const { handle, reply, answers } = harness({ groupRateLimit: { max: 1, windowMs: 60_000 } });
    const groupMsg = () => msg({ isDirectMessage: false, mentionsBot: true, chatId: "group-1" });

    await handle(groupMsg(), { reply });
    const rateLimited = await handle(groupMsg(), { reply });
    expect(rateLimited).toEqual({ action: "rate-limited" });
    expect(answers).toHaveLength(1);

    // The DM budget is untouched by the group flood above.
    await handle(msg(), { reply });
    expect(answers).toHaveLength(2);
  });

  test("dmRateLimit drops replies past budget without throwing", async () => {
    const { handle, reply, answers, chatReplies } = harness({
      dmRateLimit: { max: 1, windowMs: 60_000 },
    });

    await handle(msg(), { reply });
    const outcome = await handle(msg(), { reply });

    expect(outcome).toEqual({ action: "rate-limited" });
    expect(answers).toHaveLength(1);
    expect(chatReplies).toHaveLength(1);
  });

  test("bucketsFor, channelHint and the resolved sender/conversationId all reach prepareChat/answerFn", async () => {
    const queries: unknown[] = [];
    const store = {
      query: async (_q: string, _k: number, buckets: string[]) => {
        queries.push(buckets);
        return ["context"];
      },
    } satisfies Retriever;
    let captured: AnswerFnInput | undefined;

    const handle = createInboundPipeline(
      {
        client: {} as never,
        store,
        prompts: {
          baseSystemRules: "rules",
          publicPersona: "persona",
          privatePersona: "private persona",
        } as unknown as PromptLoader,
      },
      {
        channel: "test-channel",
        bucketsFor: () => ["base", "public", "extra"],
        channelHint: "Channel: Test.",
        answerFn: async (input) => {
          captured = input;
          return "ok";
        },
      },
    );
    const reply: InboundReplySender = {
      sendAnswer: async () => undefined,
      sendGateReply: async () => undefined,
    };

    await handle(msg(), { reply, sender: "+15550000", conversationId: "conv-1" });

    expect(queries).toEqual([["base", "public", "extra"]]);
    expect(captured?.system).toContain("Channel: Test.");
    expect(captured?.sender).toBe("+15550000");
    expect(captured?.conversationId).toBe("conv-1");
  });

  test("sender defaults to the message's senderId when omitted", async () => {
    let captured: AnswerFnInput | undefined;
    const { handle, reply } = harness({
      answerFn: async (input) => {
        captured = input;
        return "ok";
      },
    });

    await handle(msg({ senderId: "raw-jid-1" }), { reply });

    expect(captured?.sender).toBe("raw-jid-1");
  });

  test("sender accepts a thunk, resolved lazily only once gates/rate-limit pass", async () => {
    let calls = 0;
    const { handle, reply, answers } = harness();
    const sender = () => {
      calls++;
      return "resolved-sender";
    };

    // An ignored (unaddressed group) message never needs the sender resolved.
    await handle(msg({ isDirectMessage: false, mentionsBot: false }), { reply, sender });
    expect(calls).toBe(0);

    await handle(msg(), { reply, sender });
    expect(calls).toBe(1);
    expect((answers[0] as AnswerFnInput).sender).toBe("resolved-sender");
  });

  test("a personaResolver's output feeds prepareChat's personaLayer", async () => {
    let capturedSystem = "";
    const { handle, reply } = harness({
      answerFn: async (input) => {
        capturedSystem = input.system;
        return "ok";
      },
      personaResolver: async () => "you are a pirate",
    });

    await handle(msg(), { reply });

    expect(capturedSystem).toContain("you are a pirate");
  });

  test("a throwing personaResolver degrades to no persona instead of failing the reply", async () => {
    const { handle, reply, answers } = harness({
      personaResolver: async () => {
        throw new Error("registry unavailable");
      },
    });

    await handle(msg(), { reply });

    expect(answers).toHaveLength(1);
  });

  test("an intercept that claims the message short-circuits before persona/buckets/history/answer run", async () => {
    const { handle, reply, answers, chatReplies } = harness();
    const intercepted: string[] = [];

    const outcome = await handle(msg(), {
      reply,
      sender: "+1555",
      intercept: (sender) => {
        intercepted.push(sender);
        return true;
      },
    });

    expect(intercepted).toEqual(["+1555"]);
    expect(outcome).toEqual({ action: "intercepted" });
    expect(answers).toHaveLength(0);
    expect(chatReplies).toHaveLength(0);
  });

  test("an intercept that declines falls through to normal chat", async () => {
    const { handle, reply, answers } = harness();

    await handle(msg(), { reply, intercept: () => false });

    expect(answers).toHaveLength(1);
  });

  test("a rejecting answerFn propagates to the caller", async () => {
    const { handle, reply } = harness({
      answerFn: async () => {
        throw new Error("brain unavailable");
      },
    });

    await expect(handle(msg(), { reply })).rejects.toThrow("brain unavailable");
  });

  describe("conversation history", () => {
    test("with no history configured, only the latest message reaches answerFn", async () => {
      const { handle, reply, answers } = harness();

      await handle(msg({ text: "hello there" }), { reply });

      expect((answers[0] as AnswerFnInput).messages).toEqual([
        { role: "user", content: "hello there" },
      ]);
    });

    test("prior turns are loaded ahead of the new message when history is configured", async () => {
      const store = fakeHistoryStore();
      await store.append("chat-1", { role: "user", content: "earlier" });
      await store.append("chat-1", { role: "assistant", content: "earlier reply" });
      const { handle, reply, answers } = harness({ history: { store } });

      await handle(msg({ text: "hello there" }), { reply });

      expect((answers[0] as AnswerFnInput).messages).toEqual([
        { role: "user", content: "earlier" },
        { role: "assistant", content: "earlier reply" },
        { role: "user", content: "hello there" },
      ]);
    });

    test("the user turn then the assistant turn are appended, in order", async () => {
      const store = fakeHistoryStore();
      const { handle, reply } = harness({ history: { store } });

      await handle(msg({ text: "hello there" }), { reply });

      expect(store.data.get("chat-1")).toEqual([
        { role: "user", content: "hello there" },
        { role: "assistant", content: "a reply" },
      ]);
    });

    test("a rejecting answerFn still leaves the user's turn recorded", async () => {
      const store = fakeHistoryStore();
      const { handle, reply } = harness({
        history: { store },
        answerFn: async () => {
          throw new Error("brain unavailable");
        },
      });

      await expect(handle(msg({ text: "hello there" }), { reply })).rejects.toThrow();

      expect(store.data.get("chat-1")).toEqual([{ role: "user", content: "hello there" }]);
    });

    test("an empty answer still records the user's turn but not an assistant one, and reports ignore rather than reply", async () => {
      const store = fakeHistoryStore();
      const { handle, reply, chatReplies } = harness({
        history: { store },
        answerFn: async () => "",
      });

      const outcome = await handle(msg({ text: "hello there" }), { reply });

      expect(store.data.get("chat-1")).toEqual([{ role: "user", content: "hello there" }]);
      expect(chatReplies).toHaveLength(0);
      expect(outcome).toEqual({ action: "ignore" });
    });

    test("limit bounds how many prior turns are loaded", async () => {
      const store = fakeHistoryStore();
      for (let i = 0; i < 5; i++) {
        await store.append("chat-1", { role: "user", content: `turn ${i}` });
      }
      const { handle, reply, answers } = harness({ history: { store, limit: 2 } });

      await handle(msg({ text: "hello there" }), { reply });

      expect((answers[0] as AnswerFnInput).messages).toEqual([
        { role: "user", content: "turn 3" },
        { role: "user", content: "turn 4" },
        { role: "user", content: "hello there" },
      ]);
    });

    test("conversationId (not chatId) keys history when they differ", async () => {
      const store = fakeHistoryStore();
      const { handle, reply } = harness({ history: { store } });

      await handle(msg({ chatId: "chat-1", text: "hi" }), { reply, conversationId: "conv-x" });

      expect(store.data.get("conv-x")).toEqual([
        { role: "user", content: "hi" },
        { role: "assistant", content: "a reply" },
      ]);
      expect(store.data.has("chat-1")).toBe(false);
    });

    test("historyEnabledFor returning false: opted-out sender's turns are never written or read", async () => {
      const store = fakeHistoryStore();
      await store.append("chat-1", { role: "user", content: "earlier" });
      const { handle, reply, answers } = harness({
        history: { store, historyEnabledFor: () => false },
      });

      await handle(msg({ text: "hello there" }), { reply });

      // The earlier turn already in the store is never loaded back...
      expect((answers[0] as AnswerFnInput).messages).toEqual([
        { role: "user", content: "hello there" },
      ]);
      // ...and this turn is never appended either.
      expect(store.data.get("chat-1")).toEqual([{ role: "user", content: "earlier" }]);
    });

    test("historyEnabledFor is consulted with the resolved sender", async () => {
      const seen: string[] = [];
      const store = fakeHistoryStore();
      const { handle, reply } = harness({
        history: {
          store,
          historyEnabledFor: (sender) => {
            seen.push(sender);
            return true;
          },
        },
      });

      await handle(msg(), { reply, sender: "+15550000" });

      expect(seen).toEqual(["+15550000"]);
    });

    test("a throwing historyEnabledFor fails closed: history stays disabled for that turn", async () => {
      const store = fakeHistoryStore();
      const { handle, reply, answers } = harness({
        history: {
          store,
          historyEnabledFor: () => {
            throw new Error("policy store unavailable");
          },
        },
      });

      await handle(msg({ text: "hello there" }), { reply });

      expect((answers[0] as AnswerFnInput).messages).toEqual([
        { role: "user", content: "hello there" },
      ]);
      expect(store.data.has("chat-1")).toBe(false);
    });

    describe("compaction", () => {
      test("off by default: crossing a would-be threshold does nothing without config.history.compaction", async () => {
        const store = fakeHistoryStore();
        for (let i = 0; i < 4; i++) {
          await store.append("chat-1", { role: "user", content: `turn ${i}` });
        }
        const { handle, reply } = harness({ history: { store } });

        await handle(msg({ text: "hello there" }), { reply });

        expect(store.data.get("chat-1")).toHaveLength(6);
      });

      test("reaching the threshold after the reply is appended compacts before the next turn reads it back", async () => {
        const store = fakeHistoryStore();
        for (let i = 0; i < 3; i++) {
          await store.append("chat-1", { role: "user", content: `turn ${i}` });
        }
        const summarized: unknown[] = [];
        const { handle, reply, answers } = harness({
          history: {
            store,
            compaction: {
              threshold: 4,
              keep: 1,
              summarize: async (req) => {
                summarized.push(req.turns);
                return "the gist";
              },
            },
          },
        });

        await handle(msg({ text: "hello there" }), { reply });

        // 5 turns end up appended (3 seeded + the user turn + the reply) —
        // one more than `threshold` — so every one of them must have been
        // considered, not just the most recent `threshold`-sized window.
        expect(summarized).toEqual([
          [
            { role: "user", content: "turn 0" },
            { role: "user", content: "turn 1" },
            { role: "user", content: "turn 2" },
            { role: "user", content: "hello there" },
          ],
        ]);
        expect(store.data.get("chat-1")).toEqual([
          { role: "assistant", content: "Summary of earlier conversation: the gist" },
          { role: "assistant", content: "a reply" },
        ]);

        await handle(msg({ text: "another one" }), { reply });

        expect((answers[1] as AnswerFnInput).messages).toEqual([
          { role: "assistant", content: "Summary of earlier conversation: the gist" },
          { role: "assistant", content: "a reply" },
          { role: "user", content: "another one" },
        ]);
      });

      test("a failing summarize leaves the appended turns intact and does not break the reply", async () => {
        const store = fakeHistoryStore();
        for (let i = 0; i < 3; i++) {
          await store.append("chat-1", { role: "user", content: `turn ${i}` });
        }
        const { handle, reply, chatReplies } = harness({
          history: {
            store,
            compaction: {
              threshold: 4,
              keep: 1,
              summarize: async () => {
                throw new Error("summarizer unavailable");
              },
            },
          },
        });

        const outcome = await handle(msg({ text: "hello there" }), { reply });

        expect(outcome).toEqual({ action: "reply", content: "a reply" });
        expect(chatReplies).toEqual([{ chatId: "chat-1", text: "a reply" }]);
        expect(store.data.get("chat-1")).toHaveLength(5);
      });

      test("an opted-out sender's turn never triggers compaction", async () => {
        const store = fakeHistoryStore();
        for (let i = 0; i < 4; i++) {
          await store.append("chat-1", { role: "user", content: `turn ${i}` });
        }
        let called = false;
        const { handle, reply } = harness({
          history: {
            store,
            historyEnabledFor: () => false,
            compaction: {
              threshold: 4,
              keep: 1,
              summarize: async () => {
                called = true;
                return "unused";
              },
            },
          },
        });

        await handle(msg({ text: "hello there" }), { reply });

        expect(called).toBe(false);
        expect(store.data.get("chat-1")).toHaveLength(4);
      });

      test("the reply is sent before compaction runs, not blocked by it", async () => {
        const store = fakeHistoryStore();
        for (let i = 0; i < 3; i++) {
          await store.append("chat-1", { role: "user", content: `turn ${i}` });
        }
        const order: string[] = [];
        const originalClear = store.clear.bind(store);
        store.clear = async (conversationId) => {
          order.push("compaction-clear");
          await originalClear(conversationId);
        };
        const { handle, reply } = harness({
          history: { store, compaction: { threshold: 4, keep: 1, summarize: async () => "gist" } },
        });
        const originalSendAnswer = reply.sendAnswer;
        reply.sendAnswer = async (chatId, text) => {
          order.push("sent");
          await originalSendAnswer(chatId, text);
        };

        await handle(msg({ text: "hello there" }), { reply });

        expect(order).toEqual(["sent", "compaction-clear"]);
      });

      test("a store failure during compaction's rewrite is logged, not thrown — the already-sent reply still reports success", async () => {
        const store = fakeHistoryStore();
        for (let i = 0; i < 3; i++) {
          await store.append("chat-1", { role: "user", content: `turn ${i}` });
        }
        let cleared = false;
        const originalClear = store.clear.bind(store);
        const originalAppend = store.append.bind(store);
        store.clear = async (conversationId) => {
          cleared = true;
          await originalClear(conversationId);
        };
        store.append = async (conversationId, message) => {
          if (cleared) throw new Error("store unavailable");
          await originalAppend(conversationId, message);
        };
        const errors: unknown[][] = [];
        const logger = {
          debug: () => {},
          info: () => {},
          warn: () => {},
          error: (...args: unknown[]) => errors.push(args),
        };
        const { handle, reply, chatReplies } = harness({
          history: { store, compaction: { threshold: 4, keep: 1, summarize: async () => "gist" } },
          logger,
        });

        const outcome = await handle(msg({ text: "hello there" }), { reply });

        expect(outcome).toEqual({ action: "reply", content: "a reply" });
        expect(chatReplies).toEqual([{ chatId: "chat-1", text: "a reply" }]);
        expect(errors).toHaveLength(1);
      });
    });
  });

  describe("transformReply hook", () => {
    test("a string result replaces the delivered reply", async () => {
      const { handle, reply, chatReplies } = harness({
        transformReply: () => "transformed",
      });

      const outcome = await handle(msg(), { reply });

      expect(outcome).toEqual({ action: "reply", content: "transformed" });
      expect(chatReplies).toEqual([{ chatId: "chat-1", text: "transformed" }]);
    });

    test("null vetoes the reply: nothing is delivered or recorded to history", async () => {
      const store = fakeHistoryStore();
      const { handle, reply, chatReplies } = harness({
        transformReply: () => null,
        history: { store },
      });

      const outcome = await handle(msg(), { reply });

      expect(outcome).toEqual({ action: "ignore" });
      expect(chatReplies).toHaveLength(0);
      // Only the user's own turn is recorded — the vetoed assistant turn never lands.
      expect(store.data.get("chat-1")).toEqual([{ role: "user", content: "hello" }]);
    });

    // A hook that doesn't conform to its declared `string | null` return
    // (a missing `return`, say) is coerced to `null` at the `applyTransformReply`
    // boundary and so behaves exactly like an explicit veto here.
    test("a non-conforming result (e.g. undefined) is treated as a veto too", async () => {
      const { handle, reply, chatReplies } = harness({
        transformReply: () => undefined as never,
      });

      const outcome = await handle(msg(), { reply });

      expect(outcome).toEqual({ action: "ignore" });
      expect(chatReplies).toHaveLength(0);
    });

    test("a throwing transformReply is logged and the original reply is delivered", async () => {
      const lines: unknown[][] = [];
      const logger = {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: (...args: unknown[]) => lines.push(args),
      };
      const { handle, reply, chatReplies } = harness({
        transformReply: () => {
          throw new Error("plugin bug");
        },
        logger,
      });

      const outcome = await handle(msg(), { reply });

      expect(outcome).toEqual({ action: "reply", content: "a reply" });
      expect(chatReplies).toEqual([{ chatId: "chat-1", text: "a reply" }]);
      expect(lines).toHaveLength(1);
      expect(String(lines[0][0])).toContain("transformReply");
    });

    test("receives the channel, resolved sender and conversationId alongside the produced text", async () => {
      let seen:
        | { channel: string; sender?: string; conversationId?: string; text: string }
        | undefined;
      const { handle, reply } = harness({
        channel: "my-channel",
        transformReply: (ctx) => {
          seen = ctx;
          return ctx.text;
        },
      });

      await handle(msg(), { reply, sender: "user-42", conversationId: "conv-7" });

      expect(seen).toEqual({
        channel: "my-channel",
        sender: "user-42",
        conversationId: "conv-7",
        text: "a reply",
      });
    });
  });

  describe("rewriteQuery/rerankContext hooks", () => {
    test("rewriteQuery reshapes the query store.query runs, sees mode and the resolved sender", async () => {
      const queries: unknown[] = [];
      const seen: unknown[] = [];
      const store = {
        query: async (q: string) => {
          queries.push(q);
          return ["context"];
        },
      } satisfies Retriever;

      const handle = createInboundPipeline(
        {
          client: {} as never,
          store,
          prompts: {
            baseSystemRules: "rules",
            publicPersona: "persona",
            privatePersona: "private persona",
          } as unknown as PromptLoader,
        },
        {
          channel: "test-channel",
          rewriteQuery: (ctx) => {
            seen.push(ctx);
            return `expanded: ${ctx.query}`;
          },
          answerFn: async () => "ok",
        },
      );
      const reply: InboundReplySender = {
        sendAnswer: async () => undefined,
        sendGateReply: async () => undefined,
      };

      await handle(msg(), { reply, sender: "+15550000" });

      expect(queries).toEqual(["expanded: hello"]);
      expect(seen).toEqual([{ query: "hello", mode: "public", sender: "+15550000" }]);
    });

    test("rerankContext reorders the chunks folded into the assembled system prompt", async () => {
      let captured: AnswerFnInput | undefined;
      const store = {
        query: async () => ["first", "second"],
      } satisfies Retriever;

      const handle = createInboundPipeline(
        {
          client: {} as never,
          store,
          prompts: {
            baseSystemRules: "rules",
            publicPersona: "persona",
            privatePersona: "private persona",
          } as unknown as PromptLoader,
        },
        {
          channel: "test-channel",
          rerankContext: async ({ chunks }) => [...chunks].reverse(),
          answerFn: async (input) => {
            captured = input;
            return "ok";
          },
        },
      );
      const reply: InboundReplySender = {
        sendAnswer: async () => undefined,
        sendGateReply: async () => undefined,
      };

      await handle(msg(), { reply });

      expect(captured?.system).toContain("second\n\nfirst");
    });

    test("a throwing rewriteQuery is logged and retrieval falls back to the unmodified query", async () => {
      const lines: unknown[][] = [];
      const logger = {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: (...args: unknown[]) => lines.push(args),
      };
      const queries: unknown[] = [];
      const store = {
        query: async (q: string) => {
          queries.push(q);
          return ["context"];
        },
      } satisfies Retriever;

      const handle = createInboundPipeline(
        {
          client: {} as never,
          store,
          prompts: {
            baseSystemRules: "rules",
            publicPersona: "persona",
            privatePersona: "private persona",
          } as unknown as PromptLoader,
        },
        {
          channel: "test-channel",
          rewriteQuery: () => {
            throw new Error("rewrite boom");
          },
          answerFn: async () => "ok",
          logger,
        },
      );
      const reply: InboundReplySender = {
        sendAnswer: async () => undefined,
        sendGateReply: async () => undefined,
      };

      const outcome = await handle(msg(), { reply });

      expect(outcome).toEqual({ action: "reply", content: "ok" });
      expect(queries).toEqual(["hello"]);
      expect(lines).toHaveLength(1);
      expect(String(lines[0][0])).toContain("rewriteQuery");
    });
  });
});
