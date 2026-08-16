/**
 * Demo route hardening tests: origin gating and the rate limiters' config
 * wiring. Uses faked dependencies (no OpenAI, no Turso) so these run without
 * external services — the integration suite in test/integration covers the
 * end-to-end demo flow but requires real API keys.
 */

import { describe, expect, test } from "bun:test";
import type { ChatterConfig, ServerDependencies } from "../types";
import { demoRoutes } from "./demo";

function createFakeDeps(config: Partial<ChatterConfig> = {}, completionCalls: unknown[] = []) {
  const client = {
    chat: {
      completions: {
        create: async (params: unknown) => {
          completionCalls.push(params);
          return {
            choices: [{ message: { content: "reply" } }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          };
        },
      },
    },
  };

  const deps = {
    client,
    store: { query: async () => ["some context"] },
    prompts: { baseSystemRules: "rules", publicPersona: "public persona" },
    config: {
      bot: {
        name: "TestBot",
        personName: "Tester",
        publicUrl: "http://localhost:8181",
        description: "test",
      },
      openai: { apiKey: "sk-test", model: "gpt-4o-mini" },
      database: { url: "libsql://test", authToken: "" },
      ...config,
    },
  } as unknown as ServerDependencies;

  return deps;
}

function sessionRequest(headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/demo/session", { headers });
}

describe("checkDemoOrigin", () => {
  test("allows everything when no allowedOrigins are configured", async () => {
    const app = demoRoutes(createFakeDeps());
    const res = await app.fetch(sessionRequest());
    expect(res.status).toBe(200);
  });

  test("rejects a spoofed Host header claiming localhost when origins are restricted", async () => {
    const app = demoRoutes(
      createFakeDeps({ server: { allowedOrigins: ["https://real-app.com"] } }),
    );

    // The old bug: setting Host to localhost bypassed the origin check
    // entirely, regardless of the actual caller. Host is never consulted now.
    const res = await app.fetch(sessionRequest({ host: "localhost:8181" }));
    expect(res.status).toBe(403);
  });

  test("rejects a localhost Origin header when allowLocalhostDemo is not set (default off)", async () => {
    const app = demoRoutes(
      createFakeDeps({ server: { allowedOrigins: ["https://real-app.com"] } }),
    );

    // A non-browser client can set Origin to anything just as easily as
    // Host, so the localhost allowance must be opt-in, not always-on.
    const res = await app.fetch(sessionRequest({ origin: "http://localhost:5173" }));
    expect(res.status).toBe(403);
  });

  test("allows a real localhost Origin header once allowLocalhostDemo is enabled", async () => {
    const app = demoRoutes(
      createFakeDeps({
        server: { allowedOrigins: ["https://real-app.com"], allowLocalhostDemo: true },
      }),
    );

    const res = await app.fetch(sessionRequest({ origin: "http://localhost:5173" }));
    expect(res.status).toBe(200);
  });

  test("rejects a localhost-suffix bypass even with allowLocalhostDemo enabled", async () => {
    const app = demoRoutes(
      createFakeDeps({
        server: { allowedOrigins: ["https://real-app.com"], allowLocalhostDemo: true },
      }),
    );

    // "http://localhost:8080.evil.com" must not be treated as localhost —
    // a naive prefix check on "http://localhost:" would let this through.
    const res = await app.fetch(sessionRequest({ referer: "http://localhost:8080.evil.com/x" }));
    expect(res.status).toBe(403);
  });

  test("allows a configured origin and rejects a suffix-domain bypass", async () => {
    const app = demoRoutes(
      createFakeDeps({ server: { allowedOrigins: ["https://real-app.com"] } }),
    );

    const allowed = await app.fetch(sessionRequest({ origin: "https://real-app.com" }));
    expect(allowed.status).toBe(200);

    const bypass = await app.fetch(sessionRequest({ origin: "https://real-app.com.evil.com" }));
    expect(bypass.status).toBe(403);
  });
});

describe("POST /api/demo/chat", () => {
  test("routes the completion through the configured model, not a hardcoded default", async () => {
    const completionCalls: unknown[] = [];
    const app = demoRoutes(createFakeDeps({}, completionCalls));

    const res = await app.fetch(
      new Request("http://localhost/api/demo/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "hello" }),
      }),
    );

    expect(res.status).toBe(200);
    expect(completionCalls).toHaveLength(1);
    expect((completionCalls[0] as { model: string }).model).toBe("gpt-4o-mini");
  });

  test("assembles the system prompt through the shared pipeline (rules + persona + context)", async () => {
    const completionCalls: unknown[] = [];
    const app = demoRoutes(createFakeDeps({}, completionCalls));

    await app.fetch(
      new Request("http://localhost/api/demo/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "hello" }),
      }),
    );

    const messages = (completionCalls[0] as { messages: Array<{ role: string; content: string }> })
      .messages;
    expect(messages[0]).toEqual({
      role: "system",
      content: "rules\n\npublic persona\n\nContext:\nsome context",
    });
  });

  test("rejects a conversation with no user message before touching retrieval or the model", async () => {
    const completionCalls: unknown[] = [];
    const app = demoRoutes(createFakeDeps({}, completionCalls));

    const res = await app.fetch(
      new Request("http://localhost/api/demo/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "assistant", content: "hi" }] }),
      }),
    );

    expect(res.status).toBe(400);
    expect(completionCalls).toHaveLength(0);
  });
});

describe("demo rate limiting trustProxy", () => {
  test("keys by X-Forwarded-For by default (trustProxy defaults true)", async () => {
    const app = demoRoutes(createFakeDeps());

    for (let i = 0; i < 10; i++) {
      await app.fetch(sessionRequest({ "x-forwarded-for": "203.0.113.1" }));
    }
    const limited = await app.fetch(sessionRequest({ "x-forwarded-for": "203.0.113.1" }));
    expect(limited.status).toBe(429);

    // A different caller is unaffected.
    const other = await app.fetch(sessionRequest({ "x-forwarded-for": "203.0.113.2" }));
    expect(other.status).toBe(200);
  });

  test("collapses all callers onto one bucket when trustProxy is false", async () => {
    const app = demoRoutes(createFakeDeps({ rateLimit: { trustProxy: false } }));

    for (let i = 0; i < 10; i++) {
      await app.fetch(sessionRequest({ "x-forwarded-for": `203.0.113.${i + 10}` }));
    }
    // Every prior request rotated a distinct spoofed IP, yet they all shared
    // the one bucket, so the 11th caller (also a new IP) is still limited.
    const res = await app.fetch(sessionRequest({ "x-forwarded-for": "203.0.113.99" }));
    expect(res.status).toBe(429);
  });
});
