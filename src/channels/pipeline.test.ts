import { describe, expect, test } from "bun:test";
import type { AnswerFnInput } from "../core/answer";
import type { PromptLoader } from "../core/prompts";
import type { VectorStore } from "../core/retrieval";
import type { HistoryMessage, HistoryStore } from "../history/types";
import type { ChannelMessage } from "./gates";
import {
  createInboundPipeline,
  type InboundPipelineConfig,
  type InboundReplySender,
} from "./pipeline";

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

  const store = { query: async () => ["some context"] } as unknown as VectorStore;
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
    } as unknown as VectorStore;
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
});
