import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { Logger } from "../../core/logger";
import type { PromptLoader } from "../../core/prompts";
import type { VectorStore } from "../../core/retrieval";
import type { ChatterConfig, ServerDependencies } from "../../types";
import { createSenderRegistry } from "../senders";
import type { TelegramApi, TelegramMessage, TelegramUpdate, TelegramUser } from "./api";
import { createTelegramWebhookRoute, type TelegramWebhookConfig } from "./webhook";

const BOT: TelegramUser = { id: 100, username: "MyBot", is_bot: true };
const SECRET = "webhook-secret";

interface FakeApi extends TelegramApi {
  sent: Array<{ chatId: string; text: string; replyToMessageId?: number }>;
}

function fakeApi(options: { getMeFails?: boolean } = {}): FakeApi {
  const sent: FakeApi["sent"] = [];
  return {
    sent,
    call: async () => undefined as never,
    getMe: async () => {
      if (options.getMeFails) throw new Error("Unauthorized");
      return BOT;
    },
    getUpdates: async () => [],
    sendMessage: async (chatId, text, opts) => {
      sent.push({ chatId, text, replyToMessageId: opts?.replyToMessageId });
    },
    sendMedia: async () => undefined,
    setMessageReaction: async () => undefined,
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
    store: { query: async () => ["context"] } as unknown as VectorStore,
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
    logger,
  };
}

function message(overrides: Partial<TelegramMessage> = {}): TelegramMessage {
  return {
    message_id: 55,
    from: { id: 200 },
    chat: { id: 200, type: "private" },
    text: "hello",
    ...overrides,
  };
}

async function mountWebhook(
  config: Partial<TelegramWebhookConfig> = {},
): Promise<{ app: Hono; api: FakeApi; deps: ReturnType<typeof fakeDeps> }> {
  const api = config.api ?? fakeApi();
  const logger = silentLogger();
  const deps = fakeDeps(logger);
  const app = new Hono();

  const route = createTelegramWebhookRoute({
    botToken: "test-token",
    webhookSecret: SECRET,
    api,
    logger,
    ...config,
  });
  await route(app, deps);

  return { app, api: api as FakeApi, deps };
}

function post(app: Hono, update: TelegramUpdate, headers: Record<string, string> = {}) {
  return app.request("/webhooks/telegram", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(update),
  });
}

describe("createTelegramWebhookRoute", () => {
  test("throws synchronously without a webhook secret", () => {
    expect(() => createTelegramWebhookRoute({ botToken: "t", webhookSecret: "" })).toThrow(
      /webhookSecret/,
    );
    expect(() => createTelegramWebhookRoute({ botToken: "t", webhookSecret: "   " })).toThrow(
      /webhookSecret/,
    );
  });

  test("throws synchronously for a secret outside Telegram's own charset", () => {
    expect(() =>
      createTelegramWebhookRoute({ botToken: "t", webhookSecret: "has a space" }),
    ).toThrow(/charset/);
    expect(() =>
      createTelegramWebhookRoute({ botToken: "t", webhookSecret: "emoji-🔒-not-allowed" }),
    ).toThrow(/charset/);
  });

  test("rejects a POST with no secret token header", async () => {
    const { app, api } = await mountWebhook();

    const res = await post(app, { update_id: 1, message: message() });

    expect(res.status).toBe(403);
    expect(api.sent).toEqual([]);
  });

  test("rejects a POST with the wrong secret token", async () => {
    const { app, api } = await mountWebhook();

    const res = await post(
      app,
      { update_id: 1, message: message() },
      {
        "x-telegram-bot-api-secret-token": "wrong",
      },
    );

    expect(res.status).toBe(403);
    expect(api.sent).toEqual([]);
  });

  test("rejects a same-length but different secret token (exercises the byte comparison, not just the length check)", async () => {
    const { app, api } = await mountWebhook();

    const res = await post(
      app,
      { update_id: 1, message: message() },
      // Same length as SECRET ("webhook-secret"), differs in one byte.
      { "x-telegram-bot-api-secret-token": "webhook-secreT" },
    );

    expect(res.status).toBe(403);
    expect(api.sent).toEqual([]);
  });

  test("rejects a malformed JSON body", async () => {
    const { app, api } = await mountWebhook();

    const res = await app.request("/webhooks/telegram", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": SECRET,
      },
      body: "{not json",
    });

    expect(res.status).toBe(400);
    expect(api.sent).toEqual([]);
  });

  test("rejects a JSON body that isn't an object", async () => {
    const { app, api } = await mountWebhook();

    const res = await app.request("/webhooks/telegram", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": SECRET,
      },
      body: JSON.stringify(null),
    });

    expect(res.status).toBe(400);
    expect(api.sent).toEqual([]);
  });

  test("rejects an oversized body before it reaches the secret check", async () => {
    const { app, api } = await mountWebhook();

    // Deliberately the WRONG secret token (and 403 would win if the secret
    // check ran first): asserting 413 here, not 403, is what actually
    // proves the size limit is enforced before the secret comparison rather
    // than merely also being enforced at some point.
    const res = await app.request("/webhooks/telegram", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "wrong",
      },
      body: JSON.stringify({
        update_id: 1,
        message: message({ text: "x".repeat(300_000) }),
      }),
    });

    expect(res.status).toBe(413);
    expect(api.sent).toEqual([]);
  });

  test("accepts a POST with the correct secret token and runs the pipeline", async () => {
    const { app, api, deps } = await mountWebhook();

    const res = await post(
      app,
      { update_id: 1, message: message() },
      {
        "x-telegram-bot-api-secret-token": SECRET,
      },
    );

    expect(res.status).toBe(200);
    expect(deps.answered).toEqual(["hello"]);
    expect(api.sent).toEqual([{ chatId: "200", text: "the answer", replyToMessageId: 55 }]);
  });

  test("registers a sender under the channel name", async () => {
    const { deps } = await mountWebhook();

    expect(deps.senders.available("telegram")).toBe(true);
  });

  test("a custom path is honoured", async () => {
    const { app, deps } = await mountWebhook({ path: "/hooks/bot" });

    const res = await app.request("/hooks/bot", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": SECRET,
      },
      body: JSON.stringify({ update_id: 1, message: message() }),
    });

    expect(res.status).toBe(200);
    expect(deps.answered).toEqual(["hello"]);
  });

  test("a handler failure logs and still returns 200, so Telegram does not retry forever", async () => {
    const { app } = await mountWebhook({
      answerFn: () => {
        throw new Error("boom");
      },
    });

    const res = await post(
      app,
      { update_id: 1, message: message() },
      {
        "x-telegram-bot-api-secret-token": SECRET,
      },
    );

    expect(res.status).toBe(200);
  });

  test("a bad token fails route mounting loudly", async () => {
    const api = fakeApi({ getMeFails: true });
    const logger = silentLogger();
    const deps = fakeDeps(logger);
    const app = new Hono();
    const route = createTelegramWebhookRoute({
      botToken: "bad",
      webhookSecret: SECRET,
      api,
      logger,
    });

    await expect(route(app, deps)).rejects.toThrow(/Unauthorized/);
  });
});
