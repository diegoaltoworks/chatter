/**
 * Integration tests for public chat routes
 * Tests the complete flow: auth -> rate limiting -> RAG -> LLM -> response
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ApiKeyManager } from "../../src/auth/apikeys";
import { createSession } from "../../src/core/session";
import { createServer } from "../../src/server";
import type { ChatterConfig } from "../../src/types";

describe("Public Routes Integration", () => {
  const testDir = join(import.meta.dir, ".test-public-routes");
  const knowledgeDir = join(testDir, "knowledge");
  const promptsDir = join(testDir, "prompts");

  let app: Awaited<ReturnType<typeof createServer>>;
  let apiKeyManager: ApiKeyManager;
  let validApiKey: string;

  beforeAll(async () => {
    // Skip if no environment variables (CI/local without setup)
    if (!process.env.OPENAI_API_KEY || !process.env.TURSO_URL) {
      console.log("⚠️  Skipping integration tests - missing OPENAI_API_KEY or TURSO_URL");
      return;
    }

    // Create test directories
    mkdirSync(knowledgeDir, { recursive: true });
    mkdirSync(promptsDir, { recursive: true });
    mkdirSync(join(knowledgeDir, "base"), { recursive: true });
    mkdirSync(join(knowledgeDir, "public"), { recursive: true });

    // Create test knowledge
    writeFileSync(
      join(knowledgeDir, "base", "company.md"),
      "# Test Company\nWe are a test company that makes widgets.\nOur support hours are 9 AM to 5 PM EST.",
    );

    writeFileSync(
      join(knowledgeDir, "public", "pricing.md"),
      "# Pricing\nOur basic plan is $10/month.\nPro plan is $50/month.",
    );

    // Create test prompts
    writeFileSync(
      join(promptsDir, "base.txt"),
      "You are {{botName}}, a helpful assistant for {{personName}}.",
    );

    writeFileSync(join(promptsDir, "public.txt"), "Be friendly and concise.");

    writeFileSync(join(promptsDir, "private.txt"), "Internal mode.");

    // Create API key manager
    apiKeyManager = new ApiKeyManager("test-secret-for-integration-tests");
    validApiKey = await apiKeyManager.create({ name: "integration-test" });

    // Create test server configuration
    const config: ChatterConfig = {
      bot: {
        name: "TestBot",
        personName: "Test Company",
        publicUrl: "http://localhost:8181",
        description: "Integration test bot",
      },
      knowledgeDir,
      promptsDir,
      openai: {
        apiKey: process.env.OPENAI_API_KEY!,
      },
      database: {
        url: process.env.TURSO_URL!,
        authToken: process.env.TURSO_AUTH_TOKEN || "",
      },
      auth: {
        secret: "test-secret-for-integration-tests",
      },
      features: {
        enablePublicChat: true,
        enablePrivateChat: false,
        enableDemoRoutes: false,
      },
      rateLimit: {
        public: 100, // High limit for tests
        private: 100,
      },
      server: {
        cors: true,
      },
    };

    // Create server
    app = await createServer(config);
  });

  afterAll(() => {
    // Clean up test directory
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  describe("Authentication", () => {
    it("should reject request without API key", async () => {
      if (!app) return; // Skip if setup failed

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
      if (!app) return;

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
      if (!app) return;

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
    });

    it("should accept request with session key", async () => {
      if (!app) return;

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
      if (!app) return;

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
      if (!app) return;

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
      expect(json.reply).toBeDefined();
      expect(typeof json.reply).toBe("string");
    });

    it("should accept messages array format", async () => {
      if (!app) return;

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
      if (!app) return;

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
      if (!app) return;

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
      if (!app) return;

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
    it("should use knowledge base to answer questions", async () => {
      if (!app) return;

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
      // Response should reference knowledge base content
      expect(json.reply).toBeDefined();
      expect(typeof json.reply).toBe("string");
      expect(json.reply.length).toBeGreaterThan(0);
    });

    it("should access public and base knowledge", async () => {
      if (!app) return;

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
      // Should be able to reference pricing from public knowledge
    });
  });

  describe("Health and Config Endpoints", () => {
    it("should respond to health check", async () => {
      if (!app) return;

      const req = new Request("http://localhost:8181/healthz");
      const res = await app.fetch(req);

      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toBe("ok");
    });

    it("should return public config", async () => {
      if (!app) return;

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
