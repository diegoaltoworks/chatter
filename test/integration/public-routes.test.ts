/**
 * Integration tests for public chat routes
 * Tests the complete flow: auth -> rate limiting -> RAG -> LLM -> response
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { ApiKeyManager } from "../../src/auth/apikeys";
import { createSession } from "../../src/core/session";
import { createServer } from "../../src/server";
import type { ChatterConfig } from "../../src/types";
import {
  type FakeOpenAI,
  type IntegrationDirs,
  installFakeOpenAI,
  integrationConfig,
  setupIntegrationDirs,
} from "./harness";

describe("Public Routes Integration", () => {
  let dirs: IntegrationDirs;
  let fakeOpenAI: FakeOpenAI;
  let app: Awaited<ReturnType<typeof createServer>>;
  let apiKeyManager: ApiKeyManager;
  let validApiKey: string;

  beforeAll(async () => {
    dirs = setupIntegrationDirs("public-routes");
    fakeOpenAI = installFakeOpenAI({ reply: "Our support hours are 9 AM to 5 PM EST." });

    apiKeyManager = new ApiKeyManager("test-secret-for-integration-tests");
    validApiKey = await apiKeyManager.create({ name: "integration-test" });

    const config: ChatterConfig = integrationConfig(dirs, {
      auth: { secret: "test-secret-for-integration-tests" },
      features: { enablePublicChat: true, enablePrivateChat: false, enableDemoRoutes: false },
      rateLimit: { public: 100, private: 100 },
    });

    app = await createServer(config);
  });

  afterAll(() => {
    fakeOpenAI.restore();
    dirs.cleanup();
  });

  describe("Authentication", () => {
    it("should reject request without API key", async () => {
      const req = new Request("http://localhost:8181/api/public/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Hello" }),
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(401);

      const json = await res.json();
      expect(json.error).toBeDefined();
    });

    it("should reject request with invalid API key", async () => {
      const req = new Request("http://localhost:8181/api/public/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": "invalid-key-format",
        },
        body: JSON.stringify({ message: "Hello" }),
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(401);
    });

    it("should accept request with valid API key", async () => {
      const req = new Request("http://localhost:8181/api/public/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": validApiKey,
          origin: "http://localhost:8181",
        },
        body: JSON.stringify({ message: "Hello" }),
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(200);
      expect((await res.json()).reply).toBe("Our support hours are 9 AM to 5 PM EST.");
    });

    it("should accept request with session key", async () => {
      const session = createSession();

      const req = new Request("http://localhost:8181/api/public/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": session.key,
          origin: "http://localhost:8181",
        },
        body: JSON.stringify({ message: "Hello" }),
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(200);
    });
  });

  describe("Request Validation", () => {
    it("should reject empty request body", async () => {
      const req = new Request("http://localhost:8181/api/public/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": validApiKey,
          origin: "http://localhost:8181",
        },
        body: JSON.stringify({}),
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(400);

      const json = await res.json();
      expect(json.error).toContain("message");
    });

    it("should accept single message format", async () => {
      const req = new Request("http://localhost:8181/api/public/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": validApiKey,
          origin: "http://localhost:8181",
        },
        body: JSON.stringify({ message: "What are your hours?" }),
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.reply).toBe("Our support hours are 9 AM to 5 PM EST.");
    });

    it("should accept messages array format", async () => {
      const req = new Request("http://localhost:8181/api/public/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": validApiKey,
          origin: "http://localhost:8181",
        },
        body: JSON.stringify({
          messages: [
            { role: "user", content: "Hello" },
            { role: "assistant", content: "Hi there!" },
            { role: "user", content: "What are your hours?" },
          ],
        }),
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.reply).toBeDefined();
    });

    it("should reject empty messages array", async () => {
      const req = new Request("http://localhost:8181/api/public/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": validApiKey,
          origin: "http://localhost:8181",
        },
        body: JSON.stringify({ messages: [] }),
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(400);
    });
  });

  describe("CORS", () => {
    it("should set CORS headers", async () => {
      const req = new Request("http://localhost:8181/api/public/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": validApiKey,
          origin: "http://localhost:8181",
        },
        body: JSON.stringify({ message: "Hello" }),
      });

      const res = await app.fetch(req);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
    });

    it("should handle OPTIONS preflight request", async () => {
      const req = new Request("http://localhost:8181/api/public/chat", {
        method: "OPTIONS",
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    });
  });

  describe("RAG Integration", () => {
    it("should query the knowledge base and pass retrieved context to the model", async () => {
      const req = new Request("http://localhost:8181/api/public/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": validApiKey,
          origin: "http://localhost:8181",
        },
        body: JSON.stringify({ message: "What are your support hours?" }),
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.reply).toBe("Our support hours are 9 AM to 5 PM EST.");

      // Find the embeddings call carrying THIS turn's question text - not
      // just any embeddings call, which would also match server-boot chunk
      // embedding and pass even if retrieval never ran for this request.
      const embedded = fakeOpenAI.calls.find(
        (c) =>
          c.path === "/v1/embeddings" &&
          Array.isArray(c.body?.input) &&
          (c.body.input as string[]).includes("What are your support hours?"),
      );
      expect(embedded).toBeDefined();
    });

    it("should access public and base knowledge", async () => {
      const req = new Request("http://localhost:8181/api/public/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": validApiKey,
          origin: "http://localhost:8181",
        },
        body: JSON.stringify({ message: "What is your pricing?" }),
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.reply).toBeDefined();
    });
  });

  describe("Health and Config Endpoints", () => {
    it("should respond to health check", async () => {
      const req = new Request("http://localhost:8181/healthz");
      const res = await app.fetch(req);

      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toBe("ok");
    });

    it("should return public config", async () => {
      const req = new Request("http://localhost:8181/config");
      const res = await app.fetch(req);

      expect(res.status).toBe(200);
      const json = await res.json();

      expect(json.botName).toBe("TestBot");
      expect(json.publicUrl).toBe("http://localhost:8181");
      expect(json.branding).toBeDefined();
    });
  });
});
