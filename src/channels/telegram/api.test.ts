import { describe, expect, test } from "bun:test";
import {
  createTelegramApi,
  redactToken,
  splitTelegramText,
  TELEGRAM_TEXT_LIMIT,
  TelegramApiError,
  toTelegramMediaRequest,
} from "./api";

interface RecordedCall {
  url: string;
  body: Record<string, unknown>;
}

function fakeFetch(
  responses: Array<{ status?: number; body: unknown } | (() => never)>,
  calls: RecordedCall[] = [],
) {
  let index = 0;
  const doFetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (typeof next === "function") next();
    const { status = 200, body } = next as { status?: number; body: unknown };
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { doFetch, calls };
}

describe("redactToken", () => {
  test("replaces every occurrence of the token", () => {
    expect(redactToken("GET https://api.telegram.org/bot123:ABC/getMe (123:ABC)", "123:ABC")).toBe(
      "GET https://api.telegram.org/bot***/getMe (***)",
    );
  });

  test("leaves text untouched for an empty token", () => {
    expect(redactToken("nothing to hide", "")).toBe("nothing to hide");
  });
});

describe("splitTelegramText", () => {
  test("returns a single chunk when within the limit", () => {
    expect(splitTelegramText("hello")).toEqual(["hello"]);
  });

  test("returns nothing for blank text", () => {
    expect(splitTelegramText("   ")).toEqual([]);
  });

  test("splits past the limit, every chunk within it", () => {
    const text = `${"a".repeat(3000)}\n\n${"b".repeat(3000)}`;
    const chunks = splitTelegramText(text);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe("a".repeat(3000));
    expect(chunks[1]).toBe("b".repeat(3000));
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
  });

  test("hard-cuts a single word longer than the limit rather than dropping it", () => {
    const chunks = splitTelegramText("x".repeat(TELEGRAM_TEXT_LIMIT + 50));
    expect(chunks.length).toBe(2);
    expect(chunks.join("").length).toBe(TELEGRAM_TEXT_LIMIT + 50);
    expect(chunks[0]?.length).toBe(TELEGRAM_TEXT_LIMIT);
  });
});

describe("toTelegramMediaRequest", () => {
  test("maps a bare url string to sendPhoto", () => {
    expect(toTelegramMediaRequest("42", "https://cdn.example/x.png")).toEqual({
      method: "sendPhoto",
      body: { chat_id: "42", photo: "https://cdn.example/x.png" },
    });
  });

  test("maps kind + caption to the matching method", () => {
    expect(
      toTelegramMediaRequest("42", { kind: "document", url: "file-id", caption: "spec" }),
    ).toEqual({
      method: "sendDocument",
      body: { chat_id: "42", document: "file-id", caption: "spec" },
    });
  });

  test("throws on a payload with no url, so the registry reports false instead of crashing", () => {
    expect(() => toTelegramMediaRequest("42", { caption: "no url" })).toThrow(TypeError);
    expect(() => toTelegramMediaRequest("42", undefined)).toThrow(TypeError);
  });

  test("throws on an unknown kind", () => {
    expect(() => toTelegramMediaRequest("42", { kind: "hologram", url: "u" })).toThrow(
      /sendMedia kind/,
    );
  });
});

describe("createTelegramApi", () => {
  test("rejects an empty token at construction", () => {
    expect(() => createTelegramApi({ botToken: "  " })).toThrow(/botToken is required/);
  });

  test("posts to the token-scoped method URL and unwraps the envelope", async () => {
    const { doFetch, calls } = fakeFetch([
      { body: { ok: true, result: { id: 7, username: "b" } } },
    ]);
    const api = createTelegramApi({ botToken: "tok", fetch: doFetch });

    await expect(api.getMe()).resolves.toEqual({ id: 7, username: "b" });
    expect(calls[0]?.url).toBe("https://api.telegram.org/bottok/getMe");
  });

  test("getUpdates passes offset, timeout and a message-only allowlist", async () => {
    const { doFetch, calls } = fakeFetch([{ body: { ok: true, result: [] } }]);
    const api = createTelegramApi({ botToken: "tok", fetch: doFetch });

    await api.getUpdates({ offset: 12, timeoutSeconds: 30 });
    expect(calls[0]?.body).toEqual({ offset: 12, timeout: 30, allowed_updates: ["message"] });
  });

  test("getUpdates omits offset when unset, so a fresh start takes whatever is queued", async () => {
    const { doFetch, calls } = fakeFetch([{ body: { ok: true, result: [] } }]);
    const api = createTelegramApi({ botToken: "tok", fetch: doFetch });

    await api.getUpdates({ timeoutSeconds: 5 });
    expect(calls[0]?.body).not.toHaveProperty("offset");
  });

  test("a non-ok envelope becomes a TelegramApiError carrying the code and flood wait", async () => {
    const { doFetch } = fakeFetch([
      {
        status: 429,
        body: {
          ok: false,
          error_code: 429,
          description: "Too Many Requests",
          parameters: { retry_after: 7 },
        },
      },
    ]);
    const api = createTelegramApi({ botToken: "tok", fetch: doFetch });

    const error = (await api.getMe().catch((e) => e)) as TelegramApiError;
    expect(error).toBeInstanceOf(TelegramApiError);
    expect(error.errorCode).toBe(429);
    expect(error.retryAfterMs).toBe(7000);
  });

  test("a transport failure never leaks the bot token into the error", async () => {
    const { doFetch } = fakeFetch([
      () => {
        throw new Error("connect ECONNREFUSED https://api.telegram.org/botsecret-token/getMe");
      },
    ]);
    const api = createTelegramApi({ botToken: "secret-token", fetch: doFetch });

    const error = (await api.getMe().catch((e) => e)) as Error;
    expect(error).toBeInstanceOf(TelegramApiError);
    expect(error.message).not.toContain("secret-token");
    expect(error.message).toContain("***");
  });

  test("a non-JSON body fails as an api error rather than a parse crash", async () => {
    const doFetch = (async () =>
      new Response("<html>502</html>", { status: 502 })) as unknown as typeof fetch;
    const api = createTelegramApi({ botToken: "tok", fetch: doFetch });

    await expect(api.getMe()).rejects.toThrow(/non-JSON response \(HTTP 502\)/);
  });

  test("sendMessage threads only the first chunk of a long answer", async () => {
    const { doFetch, calls } = fakeFetch([{ body: { ok: true, result: {} } }]);
    const api = createTelegramApi({ botToken: "tok", fetch: doFetch });

    await api.sendMessage("42", `${"a".repeat(3000)}\n\n${"b".repeat(3000)}`, {
      replyToMessageId: 99,
    });

    expect(calls.length).toBe(2);
    expect(calls[0]?.body.reply_parameters).toEqual({
      message_id: 99,
      allow_sending_without_reply: true,
    });
    expect(calls[1]?.body).not.toHaveProperty("reply_parameters");
    expect(calls[1]?.body.chat_id).toBe("42");
  });

  test("setMessageReaction sends the Bot API reaction shape", async () => {
    const { doFetch, calls } = fakeFetch([{ body: { ok: true, result: true } }]);
    const api = createTelegramApi({ botToken: "tok", fetch: doFetch });

    await api.setMessageReaction("42", 7, "👍");
    expect(calls[0]?.url).toEndWith("/setMessageReaction");
    expect(calls[0]?.body).toEqual({
      chat_id: "42",
      message_id: 7,
      reaction: [{ type: "emoji", emoji: "👍" }],
    });
  });

  test("setWebhook posts the url and, when given, the secret token", async () => {
    const { doFetch, calls } = fakeFetch([{ body: { ok: true, result: true } }]);
    const api = createTelegramApi({ botToken: "tok", fetch: doFetch });

    await api.setWebhook("https://example.com/webhooks/telegram", { secretToken: "shh" });

    expect(calls[0]?.url).toEndWith("/setWebhook");
    expect(calls[0]?.body).toEqual({
      url: "https://example.com/webhooks/telegram",
      allowed_updates: ["message"],
      secret_token: "shh",
    });
  });

  test("setWebhook omits the secret token when not given", async () => {
    const { doFetch, calls } = fakeFetch([{ body: { ok: true, result: true } }]);
    const api = createTelegramApi({ botToken: "tok", fetch: doFetch });

    await api.setWebhook("https://example.com/webhooks/telegram");

    expect(calls[0]?.body).not.toHaveProperty("secret_token");
  });

  test("deleteWebhook calls the Bot API with no body", async () => {
    const { doFetch, calls } = fakeFetch([{ body: { ok: true, result: true } }]);
    const api = createTelegramApi({ botToken: "tok", fetch: doFetch });

    await api.deleteWebhook();

    expect(calls[0]?.url).toEndWith("/deleteWebhook");
    expect(calls[0]?.body).toEqual({});
  });

  test("a self-hosted base url replaces the default origin", async () => {
    const { doFetch, calls } = fakeFetch([{ body: { ok: true, result: [] } }]);
    const api = createTelegramApi({
      botToken: "tok",
      fetch: doFetch,
      baseUrl: "http://localhost:8081/",
    });

    await api.getUpdates({ timeoutSeconds: 1 });
    expect(calls[0]?.url).toBe("http://localhost:8081/bottok/getUpdates");
  });
});
