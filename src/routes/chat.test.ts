/**
 * Widget chat route tests
 *
 * Covers the brain hook on the public and private chat routes with faked
 * dependencies: no OpenAI, no Turso, and a locally generated RS256 keypair
 * for the private route's JWT so real verification runs offline.
 */

import { describe, expect, test } from "bun:test";
import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import type { AnswerFnInput } from "../core/answer";
import type { ChatterConfig, ServerDependencies } from "../types";
import { privateRoutes } from "./private";
import { publicRoutes } from "./public";

const PUBLIC_KEY = "test-api-key";

async function createPrivateJWT() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const publicKeyPem = await exportSPKI(publicKey);
  const token = await new SignJWT({ sub: "staff-1" })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
  return { publicKeyPem, token };
}

function createFakeDeps(config: Partial<ChatterConfig> = {}) {
  const requestedModels: string[] = [];

  const client = {
    chat: {
      completions: {
        create: async (opts: { model: string; stream?: boolean }) => {
          requestedModels.push(opts.model);
          if (opts.stream) {
            return (async function* () {
              yield { choices: [{ delta: { content: "built-in" } }] };
            })();
          }
          return {
            choices: [{ message: { content: "built-in reply" } }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          };
        },
      },
    },
  };

  const deps = {
    client,
    store: { query: async () => ["some context"] },
    prompts: {
      baseSystemRules: "rules",
      publicPersona: "public persona",
      privatePersona: "private persona",
    },
    apiKeyManager: {
      verify: async (token: string) =>
        token === PUBLIC_KEY ? { valid: true, payload: { name: "test" } } : { valid: false },
    },
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

  return { deps, requestedModels };
}

function chatRequest(path: string, body: unknown, headers: Record<string, string>) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const message = { message: "hi" };

describe("POST /api/public/chat", () => {
  test("uses the built-in completion when no brain is configured", async () => {
    const { deps, requestedModels } = createFakeDeps();
    const app = publicRoutes(deps);

    const res = await app.fetch(
      chatRequest("/api/public/chat", message, { "x-api-key": PUBLIC_KEY }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reply: "built-in reply" });
    expect(requestedModels).toEqual(["gpt-4o-mini"]);
  });

  test("consults answerFn with the public prompt and mode", async () => {
    const seen: AnswerFnInput[] = [];
    const { deps, requestedModels } = createFakeDeps({
      answerFn: async (input) => {
        seen.push(input);
        return "brain reply";
      },
    });
    const app = publicRoutes(deps);

    const res = await app.fetch(
      chatRequest("/api/public/chat", message, { "x-api-key": PUBLIC_KEY }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reply: "brain reply" });
    expect(seen).toHaveLength(1);
    expect(seen[0].mode).toBe("public");
    expect(seen[0].system).toBe("rules\n\npublic persona\n\nContext:\nsome context");
    expect(seen[0].messages).toEqual([{ role: "user", content: "hi" }]);
    expect(requestedModels).toEqual([]);
  });

  test("streams a non-streaming brain as one delta then end", async () => {
    const { deps } = createFakeDeps({ answerFn: async () => "brain reply" });
    const app = publicRoutes(deps);

    const res = await app.fetch(
      chatRequest("/api/public/chat?stream=1", message, { "x-api-key": PUBLIC_KEY }),
    );

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toBe(
      `data: ${JSON.stringify({ delta: "brain reply" })}\n\nevent: end\ndata: {}\n\n`,
    );
  });
});

describe("POST /api/private/chat", () => {
  test("consults answerFn with the private prompt and mode", async () => {
    const { publicKeyPem, token } = await createPrivateJWT();
    const seen: AnswerFnInput[] = [];
    const { deps, requestedModels } = createFakeDeps({
      auth: { jwt: { publicKeyPem } },
      answerFn: async (input) => {
        seen.push(input);
        return "brain reply";
      },
    });
    const app = privateRoutes(deps);

    const res = await app.fetch(
      chatRequest("/api/private/chat", message, { Authorization: `Bearer ${token}` }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reply: "brain reply" });
    expect(seen).toHaveLength(1);
    expect(seen[0].mode).toBe("private");
    expect(seen[0].system).toBe("rules\n\nprivate persona\n\nInternal Context:\nsome context");
    expect(requestedModels).toEqual([]);
  });

  test("uses the built-in completion when no brain is configured", async () => {
    const { publicKeyPem, token } = await createPrivateJWT();
    const { deps, requestedModels } = createFakeDeps({ auth: { jwt: { publicKeyPem } } });
    const app = privateRoutes(deps);

    const res = await app.fetch(
      chatRequest("/api/private/chat", message, { Authorization: `Bearer ${token}` }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reply: "built-in reply" });
    expect(requestedModels).toEqual(["gpt-4o-mini"]);
  });
});
