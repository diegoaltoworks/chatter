/**
 * OpenAI-compatible routes tests
 *
 * Uses faked dependencies (OpenAI client, vector store, prompts, API key
 * manager) so the wire format can be verified without external services.
 */

import { describe, expect, test } from "bun:test";
import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import type { ChatterConfig, ServerDependencies } from "../types";
import { openaiRoutes } from "./openai";

function createFakeDeps(
  overrides?: Partial<ServerDependencies>,
  configOverrides?: Partial<ChatterConfig>,
): {
  deps: ServerDependencies;
  requestedModels: string[];
  retrievedBuckets: string[][];
} {
  const requestedModels: string[] = [];
  const retrievedBuckets: string[][] = [];

  const client = {
    chat: {
      completions: {
        create: async (opts: { model: string; stream?: boolean }) => {
          requestedModels.push(opts.model);
          if (opts.stream) {
            return (async function* () {
              yield { choices: [{ delta: { content: "Hello" } }] };
              yield { choices: [{ delta: { content: " world" } }] };
            })();
          }
          return {
            choices: [{ message: { content: "Hello world" } }],
            usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
          };
        },
      },
    },
  };

  const store = {
    query: async (_q: string, _k: number, buckets: string[]) => {
      retrievedBuckets.push(buckets);
      return ["some context"];
    },
  };

  const prompts = {
    baseSystemRules: "rules",
    publicPersona: "public persona",
    privatePersona: "private persona",
  };

  const apiKeyManager = {
    verify: async (token: string) => (token === "valid-key" ? { valid: true } : { valid: false }),
  };

  const config = {
    bot: {
      name: "TestBot",
      personName: "Tester",
      publicUrl: "http://localhost:8181",
      description: "test",
    },
    openai: { apiKey: "sk-test", model: "gpt-4o-mini" },
    database: { url: "libsql://test", authToken: "" },
    ...configOverrides,
  };

  const deps = {
    client,
    store,
    prompts,
    apiKeyManager,
    config,
    ...overrides,
  } as unknown as ServerDependencies;

  return { deps, requestedModels, retrievedBuckets };
}

function completionsRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const AUTH = { Authorization: "Bearer valid-key" };

describe("POST /v1/chat/completions", () => {
  test("rejects missing API key", async () => {
    const { deps } = createFakeDeps();
    const app = openaiRoutes(deps);
    const res = await app.fetch(
      completionsRequest({ messages: [{ role: "user", content: "hi" }] }),
    );
    expect(res.status).toBe(401);
    const json = (await res.json()) as { error: { type: string } };
    expect(json.error.type).toBe("authentication_error");
  });

  test("rejects invalid API key", async () => {
    const { deps } = createFakeDeps();
    const app = openaiRoutes(deps);
    const res = await app.fetch(
      completionsRequest(
        { messages: [{ role: "user", content: "hi" }] },
        { Authorization: "Bearer wrong" },
      ),
    );
    expect(res.status).toBe(401);
  });

  test("accepts key via x-api-key header", async () => {
    const { deps } = createFakeDeps();
    const app = openaiRoutes(deps);
    const res = await app.fetch(
      completionsRequest(
        { messages: [{ role: "user", content: "hi" }] },
        { "x-api-key": "valid-key" },
      ),
    );
    expect(res.status).toBe(200);
  });

  test("rejects missing messages", async () => {
    const { deps } = createFakeDeps();
    const app = openaiRoutes(deps);
    const res = await app.fetch(completionsRequest({}, AUTH));
    expect(res.status).toBe(400);
  });

  test("rejects conversation without a user message", async () => {
    const { deps } = createFakeDeps();
    const app = openaiRoutes(deps);
    const res = await app.fetch(
      completionsRequest({ messages: [{ role: "assistant", content: "hi" }] }, AUTH),
    );
    expect(res.status).toBe(400);
  });

  test("returns an OpenAI-format completion", async () => {
    const { deps } = createFakeDeps();
    const app = openaiRoutes(deps);
    const res = await app.fetch(
      completionsRequest({ messages: [{ role: "user", content: "hi" }] }, AUTH),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      id: string;
      object: string;
      model: string;
      choices: { message: { role: string; content: string }; finish_reason: string }[];
      usage: { total_tokens: number };
    };
    expect(json.id).toStartWith("chatcmpl-");
    expect(json.object).toBe("chat.completion");
    expect(json.model).toBe("gpt-4o-mini");
    expect(json.choices[0].message).toEqual({ role: "assistant", content: "Hello world" });
    expect(json.choices[0].finish_reason).toBe("stop");
    expect(json.usage.total_tokens).toBe(12);
  });

  test("ignores client-supplied model and uses the configured one", async () => {
    const { deps, requestedModels } = createFakeDeps();
    const app = openaiRoutes(deps);
    const res = await app.fetch(
      completionsRequest(
        { model: "gpt-5-ultra", messages: [{ role: "user", content: "hi" }] },
        AUTH,
      ),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { model: string };
    expect(json.model).toBe("gpt-4o-mini");
    expect(requestedModels).toEqual(["gpt-4o-mini"]);
  });

  test("streams chat.completion.chunk events ending with [DONE]", async () => {
    const { deps } = createFakeDeps();
    const app = openaiRoutes(deps);
    const res = await app.fetch(
      completionsRequest({ stream: true, messages: [{ role: "user", content: "hi" }] }, AUTH),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const raw = await res.text();
    const events = raw
      .split("\n\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice("data: ".length));

    expect(events[events.length - 1]).toBe("[DONE]");

    const chunks = events.slice(0, -1).map((e) => JSON.parse(e));
    for (const chunk of chunks) {
      expect(chunk.object).toBe("chat.completion.chunk");
      expect(chunk.model).toBe("gpt-4o-mini");
    }

    const content = chunks.map((c) => c.choices[0].delta.content ?? "").join("");
    expect(content).toBe("Hello world");
    expect(chunks[chunks.length - 1].choices[0].finish_reason).toBe("stop");
  });
});

describe("POST /api/private/v1/chat/completions", () => {
  test("rejects requests without a JWT", async () => {
    const { deps } = createFakeDeps();
    const app = openaiRoutes(deps);
    const res = await app.fetch(
      new Request("http://localhost/api/private/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      }),
    );
    expect(res.status).toBe(401);
  });
});

describe("answerFn brain hook", () => {
  test("replaces the completion and receives the assembled prompt", async () => {
    const { deps, requestedModels } = createFakeDeps();
    const seen: { system: string; mode: string; messages: unknown }[] = [];
    deps.config.answerFn = async ({ system, mode, messages }) => {
      seen.push({ system, mode, messages });
      return "answer from the brain";
    };

    const app = openaiRoutes(deps);
    const res = await app.fetch(
      completionsRequest({ messages: [{ role: "user", content: "hi" }] }, AUTH),
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      choices: { message: { content: string } }[];
      usage: { total_tokens: number };
    };
    expect(json.choices[0].message.content).toBe("answer from the brain");
    expect(json.usage.total_tokens).toBe(0);
    expect(seen).toEqual([
      {
        system: "rules\n\npublic persona\n\nContext:\nsome context",
        mode: "public",
        messages: [{ role: "user", content: "hi" }],
      },
    ]);
    // No upstream completion was requested.
    expect(requestedModels).toEqual([]);
  });

  test("reports usage from the brain when it supplies any", async () => {
    const { deps } = createFakeDeps();
    deps.config.answerFn = async () => ({
      content: "counted",
      usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 },
    });

    const app = openaiRoutes(deps);
    const res = await app.fetch(
      completionsRequest({ messages: [{ role: "user", content: "hi" }] }, AUTH),
    );

    const json = (await res.json()) as { usage: { total_tokens: number } };
    expect(json.usage.total_tokens).toBe(11);
  });

  test("keeps the streaming wire format with a non-streaming brain", async () => {
    const { deps } = createFakeDeps();
    deps.config.answerFn = async () => "one shot answer";

    const app = openaiRoutes(deps);
    const res = await app.fetch(
      completionsRequest({ stream: true, messages: [{ role: "user", content: "hi" }] }, AUTH),
    );

    expect(res.status).toBe(200);
    const events = (await res.text())
      .split("\n\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice("data: ".length));

    expect(events[events.length - 1]).toBe("[DONE]");
    const chunks = events.slice(0, -1).map((e) => JSON.parse(e));
    expect(chunks.map((c) => c.choices[0].delta.content ?? "").join("")).toBe("one shot answer");
    expect(chunks[chunks.length - 1].choices[0].finish_reason).toBe("stop");
  });

  test("sender and a client-supplied conversation id reach the brain on the streaming path too", async () => {
    const { deps } = createFakeDeps();
    const seen: { sender?: string; conversationId?: string }[] = [];
    deps.config.answerFn = async ({ sender, conversationId }) => {
      seen.push({ sender, conversationId });
      return "streamed answer";
    };

    const app = openaiRoutes(deps);
    const res = await app.fetch(
      completionsRequest(
        { stream: true, messages: [{ role: "user", content: "hi" }] },
        { ...AUTH, "x-conversation-id": "conv-streamed" },
      ),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("x-conversation-id")).toBe("conv-streamed");
    expect(seen).toEqual([{ sender: undefined, conversationId: "conv-streamed" }]);
  });

  test("the API key's id reaches the brain as sender - never used for retrieval scope", async () => {
    const bucketsForCalls: unknown[] = [];
    const { deps, retrievedBuckets } = createFakeDeps(
      {
        apiKeyManager: {
          verify: async (token: string) =>
            token === "valid-key"
              ? {
                  valid: true,
                  payload: { sub: "key-abc", name: "k", type: "api_key", iat: 0, exp: 0 },
                }
              : { valid: false },
        } as unknown as ServerDependencies["apiKeyManager"],
      },
      {
        // Tries to widen scope with the API key id; the invariant is that it
        // never gets the chance to, because the route never hands it one.
        bucketsFor: (ctx) => {
          bucketsForCalls.push(ctx);
          return ctx.sender ? ["base", "public", "private"] : undefined;
        },
      },
    );
    const seen: (string | undefined)[] = [];
    deps.config.answerFn = async ({ sender }) => {
      seen.push(sender);
      return "ok";
    };

    const app = openaiRoutes(deps);
    await app.fetch(completionsRequest({ messages: [{ role: "user", content: "hi" }] }, AUTH));

    // The brain hook learns who called...
    expect(seen).toEqual(["key-abc"]);
    // ...but bucketsFor - the retrieval-scope gate - never sees a sender, so
    // it cannot widen past the anonymous defaults no matter what it tries.
    expect(bucketsForCalls).toEqual([{ mode: "public" }]);
    expect(retrievedBuckets).toEqual([["base", "public"]]);
  });

  test("the private route's JWT subject reaches the brain as sender", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const publicKeyPem = await exportSPKI(publicKey);
    const token = await new SignJWT({ sub: "staff-1" })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

    const { deps } = createFakeDeps(undefined, { auth: { jwt: { publicKeyPem } } });
    const seen: (string | undefined)[] = [];
    deps.config.answerFn = async ({ sender }) => {
      seen.push(sender);
      return "ok";
    };

    const app = openaiRoutes(deps);
    await app.fetch(
      new Request("http://localhost/api/private/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      }),
    );

    expect(seen).toEqual(["staff-1"]);
  });

  test("generates a conversation id when the client sends none, and echoes it in the response header", async () => {
    const { deps } = createFakeDeps();
    const seen: (string | undefined)[] = [];
    deps.config.answerFn = async ({ conversationId }) => {
      seen.push(conversationId);
      return "ok";
    };

    const app = openaiRoutes(deps);
    const res = await app.fetch(
      completionsRequest({ messages: [{ role: "user", content: "hi" }] }, AUTH),
    );

    const headerConvId = res.headers.get("x-conversation-id");
    expect(headerConvId).toBeTruthy();
    expect(seen).toEqual([headerConvId ?? undefined]);
  });

  test("honors a client-supplied x-conversation-id header over generating one", async () => {
    const { deps } = createFakeDeps();
    const seen: (string | undefined)[] = [];
    deps.config.answerFn = async ({ conversationId }) => {
      seen.push(conversationId);
      return "ok";
    };

    const app = openaiRoutes(deps);
    const res = await app.fetch(
      completionsRequest(
        { messages: [{ role: "user", content: "hi" }] },
        { ...AUTH, "x-conversation-id": "conv-from-header" },
      ),
    );

    expect(seen).toEqual(["conv-from-header"]);
    expect(res.headers.get("x-conversation-id")).toBe("conv-from-header");
  });

  test("honors a client-supplied conversation_id body field", async () => {
    const { deps } = createFakeDeps();
    const seen: (string | undefined)[] = [];
    deps.config.answerFn = async ({ conversationId }) => {
      seen.push(conversationId);
      return "ok";
    };

    const app = openaiRoutes(deps);
    await app.fetch(
      completionsRequest(
        { messages: [{ role: "user", content: "hi" }], conversation_id: "conv-from-body" },
        AUTH,
      ),
    );

    expect(seen).toEqual(["conv-from-body"]);
  });

  test("falls back to a generated id when the client's conversation_id is malformed or oversized", async () => {
    const { deps } = createFakeDeps();
    const seen: (string | undefined)[] = [];
    deps.config.answerFn = async ({ conversationId }) => {
      seen.push(conversationId);
      return "ok";
    };
    const app = openaiRoutes(deps);

    for (const badId of ["a\nb", "héllo-🎉", "x".repeat(100_000), "   "]) {
      const res = await app.fetch(
        completionsRequest(
          { messages: [{ role: "user", content: "hi" }], conversation_id: badId },
          AUTH,
        ),
      );
      expect(res.status).toBe(200);
      const headerConvId = res.headers.get("x-conversation-id");
      expect(headerConvId).toBeTruthy();
      expect(headerConvId).not.toBe(badId);
    }
    expect(seen).toHaveLength(4);
    expect(seen.every((id) => typeof id === "string" && id.length <= 200)).toBe(true);
  });
});

describe("feature flags", () => {
  test("public v1 route is absent when public chat is disabled", async () => {
    const { deps } = createFakeDeps();
    deps.config.features = { enablePublicChat: false };
    const app = openaiRoutes(deps);
    const res = await app.fetch(
      completionsRequest({ messages: [{ role: "user", content: "hi" }] }, AUTH),
    );
    expect(res.status).toBe(404);
  });
});

describe("bucketsFor on the OpenAI-compatible route", () => {
  test("retrieves the mode defaults when no hook is configured", async () => {
    const { deps, retrievedBuckets } = createFakeDeps();
    const app = openaiRoutes(deps);

    await app.fetch(completionsRequest({ messages: [{ role: "user", content: "hi" }] }, AUTH));

    expect(retrievedBuckets).toEqual([["base", "public"]]);
  });

  test("the API-key surface stays anonymous and cannot reach private knowledge", async () => {
    const seen: unknown[] = [];
    const { deps, retrievedBuckets } = createFakeDeps(undefined, {
      bucketsFor: (ctx) => {
        seen.push(ctx);
        return ["base", "public", "private"];
      },
    });
    const app = openaiRoutes(deps);

    // An API key names the calling application, not a user - so the hook is
    // consulted without a sender and its request for `private` is dropped.
    await app.fetch(completionsRequest({ messages: [{ role: "user", content: "hi" }] }, AUTH));

    expect(seen).toEqual([{ mode: "public" }]);
    expect(retrievedBuckets).toEqual([["base", "public"]]);
  });

  test("the private v1 route supplies the JWT subject and honours the hook", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const publicKeyPem = await exportSPKI(publicKey);
    const token = await new SignJWT({ sub: "staff-1" })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

    const seen: unknown[] = [];
    const { deps, retrievedBuckets } = createFakeDeps(undefined, {
      auth: { jwt: { publicKeyPem } },
      bucketsFor: (ctx) => {
        seen.push(ctx);
        return ["base", "private", "finance"];
      },
    });
    const app = openaiRoutes(deps);

    const res = await app.fetch(
      new Request("http://localhost/api/private/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      }),
    );

    expect(res.status).toBe(200);
    expect(seen).toEqual([{ mode: "private", sender: "staff-1" }]);
    expect(retrievedBuckets).toEqual([["base", "private", "finance"]]);
  });
});
