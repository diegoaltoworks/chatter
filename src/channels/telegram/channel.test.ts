import { describe, expect, test } from "bun:test";
import type { TransformReplyInput } from "../../core/answer";
import type { Logger } from "../../core/logger";
import type { PromptLoader } from "../../core/prompts";
import type { Retriever } from "../../core/retrieval";
import type { ChatterConfig, ServerDependencies } from "../../types";
import { createSenderRegistry } from "../senders";
import type { TelegramApi, TelegramMessage, TelegramUpdate, TelegramUser } from "./api";
import { createTelegramChannel, type TelegramChannelConfig } from "./channel";

const BOT: TelegramUser = { id: 100, username: "MyBot", is_bot: true };

interface FakeApi extends TelegramApi {
  sent: Array<{ chatId: string; text: string; replyToMessageId?: number }>;
  media: Array<{ chatId: string; payload: unknown }>;
  reactions: Array<{ chatId: string; messageId: number; emoji: string }>;
  polls: Array<number | undefined>;
}

/** A Bot API that serves one scripted batch of updates and then nothing — no network, no token. */
function fakeApi(batches: TelegramUpdate[][], options: { getMeFails?: boolean } = {}): FakeApi {
  const sent: FakeApi["sent"] = [];
  const media: FakeApi["media"] = [];
  const reactions: FakeApi["reactions"] = [];
  const polls: FakeApi["polls"] = [];
  let round = 0;

  return {
    sent,
    media,
    reactions,
    polls,
    call: async () => undefined as never,
    getMe: async () => {
      if (options.getMeFails) throw new Error("Unauthorized");
      return BOT;
    },
    getUpdates: ({ offset }) => {
      polls.push(offset);
      const batch = batches[round++];
      // Past the script, hold the request open like a real long poll instead
      // of resolving empty forever — a test that spun that loop would starve
      // the pipeline work it is waiting on.
      return batch ? Promise.resolve(batch) : new Promise<TelegramUpdate[]>(() => undefined);
    },
    sendMessage: async (chatId, text, opts) => {
      sent.push({ chatId, text, replyToMessageId: opts?.replyToMessageId });
    },
    sendMedia: async (chatId, payload) => {
      media.push({ chatId, payload });
    },
    setMessageReaction: async (chatId, messageId, emoji) => {
      reactions.push({ chatId, messageId, emoji });
    },
    setWebhook: async () => undefined,
    deleteWebhook: async () => undefined,
  };
}

function silentLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  const record = (...args: unknown[]) => {
    lines.push(String(args[0]));
  };
  return { lines, debug: record, info: record, warn: record, error: record };
}

function fakeDeps(
  logger: Logger,
  configOverrides: Partial<ChatterConfig> = {},
): ServerDependencies & { answered: string[] } {
  const answered: string[] = [];
  return {
    answered,
    client: {} as ServerDependencies["client"],
    db: {} as ServerDependencies["db"],
    store: { query: async () => ["context"] } satisfies Retriever,
    prompts: {
      baseSystemRules: "rules",
      publicPersona: "persona",
      privatePersona: "private",
    } as unknown as PromptLoader,
    config: {
      answerFn: async (input: { messages: Array<{ content: string }> }) => {
        answered.push(input.messages.at(-1)?.content ?? "");
        return "the answer";
      },
      ...configOverrides,
    } as unknown as ServerDependencies["config"],
    senders: createSenderRegistry(logger),
    identities: new Map<string, string[]>(),
    logger,
  };
}

function message(overrides: Partial<TelegramMessage> = {}): TelegramMessage {
  return {
    message_id: 55,
    from: { id: 200 },
    chat: { id: -4242, type: "supergroup" },
    text: "@MyBot hello",
    entities: [{ type: "mention", offset: 0, length: 6 }],
    ...overrides,
  };
}

/** Lets the poll loop fetch its scripted batch and run the pipeline to completion. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

/** Runs the channel over one scripted batch and stops it, so no timer or poll outlives the test. */
async function runChannel(
  updates: TelegramUpdate[],
  config: Partial<TelegramChannelConfig> = {},
): Promise<{
  api: FakeApi;
  deps: ReturnType<typeof fakeDeps>;
  logger: Logger & { lines: string[] };
}> {
  const api = fakeApi([updates]);
  const logger = silentLogger();
  const deps = fakeDeps(logger);
  const channel = createTelegramChannel({
    botToken: "test-token",
    api,
    sleep: async () => undefined,
    logger,
    ...config,
  });

  await channel.start(deps);
  await settle();
  await channel.stop?.();
  return { api, deps, logger };
}

describe("createTelegramChannel", () => {
  test("answers an addressed group message, threaded onto it", async () => {
    const { api, deps } = await runChannel([{ update_id: 1, message: message() }]);

    expect(deps.answered).toEqual(["@MyBot hello"]);
    expect(api.sent).toEqual([{ chatId: "-4242", text: "the answer", replyToMessageId: 55 }]);
  });

  test("ignores an unaddressed group message", async () => {
    const { api, deps } = await runChannel([
      { update_id: 1, message: message({ text: "lunch?", entities: [] }) },
    ]);

    expect(deps.answered).toEqual([]);
    expect(api.sent).toEqual([]);
  });

  test("answers a DM without needing a mention", async () => {
    const { api } = await runChannel([
      {
        update_id: 1,
        message: message({ chat: { id: 200, type: "private" }, text: "hi", entities: [] }),
      },
    ]);

    expect(api.sent).toHaveLength(1);
    expect(api.sent[0]?.chatId).toBe("200");
  });

  test("never answers its own message (loop guard)", async () => {
    const { api } = await runChannel([{ update_id: 1, message: message({ from: { id: 100 } }) }]);

    expect(api.sent).toEqual([]);
  });

  test("mute/unmute acknowledgements are sent unthreaded", async () => {
    const { api } = await runChannel(
      [
        { update_id: 1, message: message({ text: "/mute", entities: [] }) },
        { update_id: 2, message: message() },
        { update_id: 3, message: message({ text: "/unmute", entities: [] }) },
      ],
      {
        muteRegex: /^\/mute$/i,
        unmuteRegex: /^\/unmute$/i,
        muteReply: "Muted.",
        unmuteReply: "Back.",
      },
    );

    expect(api.sent.map((s) => s.text)).toEqual(["Muted.", "Back."]);
    expect(api.sent.every((s) => s.replyToMessageId === undefined)).toBe(true);
  });

  test("a non-allowlisted group is skipped and logged once", async () => {
    const { api, logger } = await runChannel(
      [
        { update_id: 1, message: message() },
        { update_id: 2, message: message() },
      ],
      { allowedChats: ["-1"] },
    );

    expect(api.sent).toEqual([]);
    expect(logger.lines.filter((line) => line.includes("not in allowedChats"))).toHaveLength(1);
  });

  test("the persona resolver receives the namespaced sender key", async () => {
    const seen: string[] = [];
    await runChannel([{ update_id: 1, message: message() }], {
      personaResolver: ({ sender }) => {
        seen.push(sender);
        return undefined;
      },
    });

    expect(seen).toEqual(["tg:200"]);
  });

  test("registers its own identity in the process registry, so a sibling channel sees it", async () => {
    const { deps } = await runChannel([]);
    expect(deps.identities.get("telegram")).toEqual(["100"]);
  });

  test("a channel-supplied identity registry is used instead of the server's", async () => {
    const own = new Map<string, string[]>();
    const { deps } = await runChannel([], { identities: own, name: "telegram:support" });

    expect(own.get("telegram:support")).toEqual(["100"]);
    expect(deps.identities.size).toBe(0);
  });

  test("a message from another endpoint of this process is ignored, not answered", async () => {
    const logger = silentLogger();
    const deps = fakeDeps(logger);
    // The sibling registered first, exactly as a channel started earlier in
    // the same createServer call would have.
    deps.identities.set("telegram:support", ["900"]);

    const api = fakeApi([[{ update_id: 1, message: message({ from: { id: 900 } }) }]]);
    const channel = createTelegramChannel({
      botToken: "test-token",
      api,
      sleep: async () => undefined,
      logger,
    });

    await channel.start(deps);
    await settle();
    await channel.stop?.();

    expect(deps.answered).toEqual([]);
    expect(api.sent).toEqual([]);
  });

  test("registers a sender supporting text, media and reactions", async () => {
    const api = fakeApi([[]]);
    const logger = silentLogger();
    const deps = fakeDeps(logger);
    const channel = createTelegramChannel({
      botToken: "t",
      api,
      sleep: async () => undefined,
      logger,
    });

    await channel.start(deps);
    expect(deps.senders.available("telegram")).toBe(true);
    expect(await deps.senders.sendText("telegram", "42", "ping")).toBe(true);
    expect(await deps.senders.sendMedia("telegram", "42", "https://cdn/x.png")).toBe(true);
    expect(await deps.senders.sendReaction("telegram", "42", 7, "👍")).toBe(true);
    await channel.stop?.();

    expect(api.sent[0]).toEqual({ chatId: "42", text: "ping", replyToMessageId: undefined });
    expect(api.media[0]).toEqual({ chatId: "42", payload: "https://cdn/x.png" });
    expect(api.reactions[0]).toEqual({ chatId: "42", messageId: 7, emoji: "👍" });
  });

  test("stop unregisters the sender so later sends degrade to false", async () => {
    const { deps } = await runChannel([]);
    expect(deps.senders.available("telegram")).toBe(false);
    expect(await deps.senders.sendText("telegram", "42", "ping")).toBe(false);
  });

  test("a custom name lets two bots share one process and one registry", async () => {
    const logger = silentLogger();
    const deps = fakeDeps(logger);
    const channel = createTelegramChannel({
      botToken: "t",
      name: "telegram:support",
      api: fakeApi([[]]),
      sleep: async () => undefined,
      logger,
    });

    await channel.start(deps);
    expect(deps.senders.available("telegram:support")).toBe(true);
    expect(deps.senders.available("telegram")).toBe(false);
    await channel.stop?.();
    expect(deps.senders.available("telegram:support")).toBe(false);
  });

  test("a bad token fails start() loudly instead of polling forever", async () => {
    const logger = silentLogger();
    const deps = fakeDeps(logger);
    const channel = createTelegramChannel({
      botToken: "bad",
      api: fakeApi([[]], { getMeFails: true }),
      sleep: async () => undefined,
      logger,
    });

    await expect(channel.start(deps)).rejects.toThrow(/Unauthorized/);
    expect(deps.senders.available("telegram")).toBe(false);
  });

  test("polling resumes past each handled update", async () => {
    const { api } = await runChannel([
      { update_id: 41, message: message({ text: "lunch?", entities: [] }) },
    ]);

    expect(api.polls[0]).toBeUndefined();
    expect(api.polls[1]).toBe(42);
  });

  test("channelHint defaults to Telegram and is overridable", async () => {
    const hints: Array<string | undefined> = [];
    const api = fakeApi([[{ update_id: 1, message: message() }]]);
    const logger = silentLogger();
    const deps = fakeDeps(logger);

    const channel = createTelegramChannel({
      botToken: "t",
      api,
      sleep: async () => undefined,
      logger,
      answerFn: (input) => {
        hints.push(input.system);
        return "";
      },
    });
    await channel.start(deps);
    await settle();
    await channel.stop?.();

    expect(hints[0]).toContain("Channel: Telegram.");
  });

  async function runWithTransformReply(
    transformReply: (ctx: TransformReplyInput) => string | null,
    channelConfig: Partial<TelegramChannelConfig> = {},
  ): Promise<{ api: FakeApi; logger: Logger & { lines: string[] } }> {
    const api = fakeApi([[{ update_id: 1, message: message() }]]);
    const logger = silentLogger();
    const deps = fakeDeps(logger, { transformReply });

    const channel = createTelegramChannel({
      botToken: "t",
      api,
      sleep: async () => undefined,
      logger,
      ...channelConfig,
    });
    await channel.start(deps);
    await settle();
    await channel.stop?.();
    return { api, logger };
  }

  test("transformReply replaces the delivered text", async () => {
    const { api } = await runWithTransformReply(() => "replaced");

    expect(api.sent).toEqual([{ chatId: "-4242", text: "replaced", replyToMessageId: 55 }]);
  });

  test("transformReply sees the channel identity, including a configured multi-bot name", async () => {
    const seen: string[] = [];
    await runWithTransformReply(
      (ctx) => {
        seen.push(ctx.channel);
        return ctx.text;
      },
      { name: "support-bot" },
    );

    expect(seen).toEqual(["support-bot"]);
  });

  test("transformReply vetoing the reply sends nothing", async () => {
    const { api } = await runWithTransformReply(() => null);

    expect(api.sent).toEqual([]);
  });

  test("a throwing transformReply is logged and keeps the original reply", async () => {
    const { api, logger } = await runWithTransformReply(() => {
      throw new Error("boom");
    });

    expect(api.sent).toEqual([{ chatId: "-4242", text: "the answer", replyToMessageId: 55 }]);
    expect(logger.lines.some((line) => line.includes("transformReply"))).toBe(true);
  });

  test("a channel-level rewriteQuery reaches retrieval and overrides the server's own", async () => {
    const queries: string[] = [];
    const api = fakeApi([[{ update_id: 1, message: message() }]]);
    const logger = silentLogger();
    const deps = fakeDeps(logger, {
      rewriteQuery: () => "server rewrite",
    });
    deps.store = {
      query: async (q: string) => {
        queries.push(q);
        return ["context"];
      },
    } as unknown as ServerDependencies["store"];

    const channel = createTelegramChannel({
      botToken: "t",
      api,
      sleep: async () => undefined,
      logger,
      rewriteQuery: () => "channel rewrite",
    });
    await channel.start(deps);
    await settle();
    await channel.stop?.();

    expect(queries).toEqual(["channel rewrite"]);
  });

  test("the server's rewriteQuery/rerankContext are used when the channel sets neither", async () => {
    const queries: string[] = [];
    const rerankSeen: unknown[] = [];
    const api = fakeApi([[{ update_id: 1, message: message() }]]);
    const logger = silentLogger();
    const deps = fakeDeps(logger, {
      rewriteQuery: (ctx) => `server: ${ctx.query}`,
      rerankContext: (ctx) => {
        rerankSeen.push(ctx);
        return [...ctx.chunks].reverse();
      },
    });
    deps.store = {
      query: async (q: string) => {
        queries.push(q);
        return ["first", "second"];
      },
    } as unknown as ServerDependencies["store"];

    const channel = createTelegramChannel({
      botToken: "t",
      api,
      sleep: async () => undefined,
      logger,
    });
    await channel.start(deps);
    await settle();
    await channel.stop?.();

    expect(queries).toEqual(["server: @MyBot hello"]);
    expect(rerankSeen).toEqual([{ query: "server: @MyBot hello", chunks: ["first", "second"] }]);
  });

  test("a throwing rewriteQuery is logged and the poll loop keeps answering with the unmodified query", async () => {
    const queries: string[] = [];
    const api = fakeApi([[{ update_id: 1, message: message() }]]);
    const logger = silentLogger();
    const deps = fakeDeps(logger);
    deps.store = {
      query: async (q: string) => {
        queries.push(q);
        return ["context"];
      },
    } as unknown as ServerDependencies["store"];

    const channel = createTelegramChannel({
      botToken: "t",
      api,
      sleep: async () => undefined,
      logger,
      rewriteQuery: () => {
        throw new Error("boom");
      },
    });
    await channel.start(deps);
    await settle();
    await channel.stop?.();

    expect(queries).toEqual(["@MyBot hello"]);
    expect(api.sent).toEqual([{ chatId: "-4242", text: "the answer", replyToMessageId: 55 }]);
    expect(logger.lines.some((line) => line.includes("rewriteQuery"))).toBe(true);
  });
});
