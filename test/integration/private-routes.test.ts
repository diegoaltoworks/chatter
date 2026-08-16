import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import { createServer } from "../../src/server";
import type { ChatterConfig } from "../../src/types";
import {
  type FakeOpenAI,
  type IntegrationDirs,
  installFakeOpenAI,
  integrationConfig,
  setupIntegrationDirs,
} from "./harness";

describe("Private Routes Integration", () => {
  let dirs: IntegrationDirs;
  let fakeOpenAI: FakeOpenAI;
  let app: Awaited<ReturnType<typeof createServer>>;
  let validToken: string;
  let jwtAuth: NonNullable<ChatterConfig["auth"]>;

  beforeAll(async () => {
    dirs = setupIntegrationDirs("private-routes");
    fakeOpenAI = installFakeOpenAI({ reply: "4" });

    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const publicKeyPem = await exportSPKI(publicKey);

    validToken = await new SignJWT({ sub: "test-user-123" })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer("https://test-issuer.example.com")
      .setAudience("test-api")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);

    jwtAuth = {
      jwt: {
        publicKeyPem,
        issuer: "https://test-issuer.example.com",
        audience: "test-api",
      },
    };

    const config: ChatterConfig = integrationConfig(dirs, {
      features: { enablePublicChat: false, enablePrivateChat: true, enableDemoRoutes: false },
      auth: jwtAuth,
      rateLimit: { private: 100 },
    });

    app = await createServer(config);
  });

  afterAll(() => {
    fakeOpenAI.restore();
    dirs.cleanup();
  });

  describe("POST /api/private/chat", () => {
    it("should reject request without JWT token", async () => {
      const req = new Request("http://localhost/api/private/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "test message" }),
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(401);

      const json = await res.json();
      expect(json.error).toBe("Unauthorized");
    });

    it("should reject request with invalid JWT token", async () => {
      const req = new Request("http://localhost/api/private/chat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer invalid.jwt.token",
        },
        body: JSON.stringify({ message: "test message" }),
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(401);
    });

    it("should accept valid JWT and respond to single message", async () => {
      const req = new Request("http://localhost/api/private/chat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${validToken}`,
        },
        body: JSON.stringify({ message: "Hello" }),
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.reply).toBe("4");
    });

    it("should accept valid JWT and respond to conversation history", async () => {
      const req = new Request("http://localhost/api/private/chat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${validToken}`,
        },
        body: JSON.stringify({
          messages: [
            { role: "user", content: "What is 2+2?" },
            { role: "assistant", content: "2+2 equals 4." },
            { role: "user", content: "And what is 3+3?" },
          ],
        }),
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.reply).toBe("4");
    });

    it("should support streaming with stream=1 query parameter", async () => {
      const req = new Request("http://localhost/api/private/chat?stream=1", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${validToken}`,
        },
        body: JSON.stringify({ message: "Hi" }),
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(200);

      const reader = res.body?.getReader();
      expect(reader).toBeDefined();

      const decoder = new TextDecoder();
      let chunks = "";

      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks += decoder.decode(value, { stream: true });
      }

      expect(chunks).toContain("data:");
      expect(chunks).toContain("event: end");
    });

    it("should support streaming with text/event-stream accept header", async () => {
      const req = new Request("http://localhost/api/private/chat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          authorization: `Bearer ${validToken}`,
        },
        body: JSON.stringify({ message: "Hello" }),
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(200);

      const reader = res.body?.getReader();
      expect(reader).toBeDefined();
    });

    it("should return error for empty messages array", async () => {
      const req = new Request("http://localhost/api/private/chat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${validToken}`,
        },
        body: JSON.stringify({ messages: [] }),
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(400);

      const json = await res.json();
      expect(json.error).toContain("empty");
    });

    it("should return error when no message or messages provided", async () => {
      const req = new Request("http://localhost/api/private/chat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${validToken}`,
        },
        body: JSON.stringify({}),
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(400);

      const json = await res.json();
      expect(json.error).toContain("required");
    });

    it("should use RAG context from vector store", async () => {
      const req = new Request("http://localhost/api/private/chat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${validToken}`,
        },
        body: JSON.stringify({ message: "Tell me about your capabilities" }),
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.reply).toBeDefined();

      // Find the embeddings call carrying THIS turn's question text - not
      // just any embeddings call, which would also match server-boot chunk
      // embedding and pass even if retrieval never ran for this request.
      const embedded = fakeOpenAI.calls.find(
        (c) =>
          c.path === "/v1/embeddings" &&
          Array.isArray(c.body?.input) &&
          (c.body.input as string[]).includes("Tell me about your capabilities"),
      );
      expect(embedded).toBeDefined();
    });

    it("should handle malformed JSON gracefully", async () => {
      const req = new Request("http://localhost/api/private/chat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${validToken}`,
        },
        body: "not valid json",
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(400);
    });
  });

  describe("Rate Limiting", () => {
    it("allows requests within the configured limit", async () => {
      const requests = Array.from({ length: 5 }, () =>
        app.fetch(
          new Request("http://localhost/api/private/chat", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${validToken}`,
            },
            body: JSON.stringify({ message: "test" }),
          }),
        ),
      );

      const responses = await Promise.all(requests);

      // rateLimit.private is 100 for the shared `app` - well above 5, so
      // every one of these must succeed; a flaky 429 here would mean the
      // limiter is keying wrong, not that the limit was hit on purpose.
      for (const res of responses) {
        expect(res.status).toBe(200);
      }
    });

    it("rejects requests once the configured limit is exceeded", async () => {
      const lowLimitApp = await createServer(
        integrationConfig(dirs, {
          features: { enablePublicChat: false, enablePrivateChat: true, enableDemoRoutes: false },
          auth: jwtAuth,
          rateLimit: { private: 3 },
        }),
      );

      const request = () =>
        lowLimitApp.fetch(
          new Request("http://localhost/api/private/chat", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${validToken}`,
            },
            body: JSON.stringify({ message: "test" }),
          }),
        );

      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) {
        statuses.push((await request()).status);
      }

      expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
      expect(statuses.slice(3)).toEqual([429, 429]);
    });
  });
});
