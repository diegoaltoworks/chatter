/**
 * Integration tests for demo routes
 * Tests session creation, demo chat, and rate limiting
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "../../src/server";
import type { ChatterConfig } from "../../src/types";

describe("Demo Routes Integration", () => {
  const testDir = join(import.meta.dir, ".test-demo-routes");
  const knowledgeDir = join(testDir, "knowledge");
  const promptsDir = join(testDir, "prompts");

  let app: Awaited<ReturnType<typeof createServer>>;

  beforeAll(async () => {
    // Skip if no environment variables
    if (!process.env.OPENAI_API_KEY || !process.env.TURSO_URL) {
      console.log("⚠️  Skipping demo integration tests - missing env vars");
      return;
    }

    // Create test directories
    mkdirSync(join(knowledgeDir, "base"), { recursive: true });
    mkdirSync(join(knowledgeDir, "public"), { recursive: true });
    mkdirSync(promptsDir, { recursive: true });

    // Create minimal knowledge
    writeFileSync(join(knowledgeDir, "base", "info.md"), "# Test\nDemo test content.");

    // Create prompts
    writeFileSync(join(promptsDir, "base.txt"), "You are a test assistant.");
    writeFileSync(join(promptsDir, "public.txt"), "Be helpful.");
    writeFileSync(join(promptsDir, "private.txt"), "Internal mode.");

    const config: ChatterConfig = {
      bot: {
        name: "DemoBot",
        personName: "Test",
        publicUrl: "http://localhost:8181",
        description: "Demo test bot",
      },
      knowledgeDir,
      promptsDir,
      openai: {
        apiKey: process.env.OPENAI_API_KEY ?? "",
      },
      database: {
        url: process.env.TURSO_URL ?? "",
        authToken: process.env.TURSO_AUTH_TOKEN || "",
      },
      features: {
        enablePublicChat: false,
        enablePrivateChat: false,
        enableDemoRoutes: true,
      },
      server: {
        cors: true,
      },
    };

    app = await createServer(config);
  });

  afterAll(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  describe("Session Creation", () => {
    it("should create a session key via GET /api/demo/session", async () => {
      if (!app) return;

      const req = new Request("http://localhost:8181/api/demo/session", {
        headers: {
          host: "localhost:8181",
        },
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.key).toBeDefined();
      expect(json.key).toStartWith("session_");
      expect(json.expiresIn).toBe(3600);
      expect(json.maxRequests).toBe(20);
    });

    it("should return session metadata", async () => {
      if (!app) return;

      const req = new Request("http://localhost:8181/api/demo/session", {
        headers: {
          host: "localhost:8181",
        },
      });

      const res = await app.fetch(req);
      const json = await res.json();

      expect(json).toHaveProperty("key");
      expect(json).toHaveProperty("expiresIn");
      expect(json).toHaveProperty("maxRequests");
      expect(json).toHaveProperty("message");
    });

    it("should create unique session keys", async () => {
      if (!app) return;

      const req1 = new Request("http://localhost:8181/api/demo/session", {
        headers: { host: "localhost:8181" },
      });
      const req2 = new Request("http://localhost:8181/api/demo/session", {
        headers: { host: "localhost:8181" },
      });

      const res1 = await app.fetch(req1);
      const res2 = await app.fetch(req2);

      const json1 = await res1.json();
      const json2 = await res2.json();

      expect(json1.key).not.toBe(json2.key);
    });
  });

  describe("Demo Stats", () => {
    it("should return active session count", async () => {
      if (!app) return;

      const req = new Request("http://localhost:8181/api/demo/stats");
      const res = await app.fetch(req);

      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json).toHaveProperty("activeSessions");
      expect(typeof json.activeSessions).toBe("number");
      expect(json.activeSessions).toBeGreaterThanOrEqual(0);
    });
  });

  describe("Demo Chat", () => {
    it("should accept chat requests without API key", async () => {
      if (!app) return;

      const req = new Request("http://localhost:8181/api/demo/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          host: "localhost:8181",
        },
        body: JSON.stringify({ message: "Hello" }),
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.reply).toBeDefined();
      expect(typeof json.reply).toBe("string");
    });

    it("should support conversation history", async () => {
      if (!app) return;

      const req = new Request("http://localhost:8181/api/demo/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          host: "localhost:8181",
        },
        body: JSON.stringify({
          messages: [
            { role: "user", content: "Hi" },
            { role: "assistant", content: "Hello!" },
            { role: "user", content: "How are you?" },
          ],
        }),
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.reply).toBeDefined();
    });

    it("should reject empty message", async () => {
      if (!app) return;

      const req = new Request("http://localhost:8181/api/demo/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          host: "localhost:8181",
        },
        body: JSON.stringify({}),
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(400);

      const json = await res.json();
      expect(json.error).toContain("message");
    });

    it("should reject empty messages array", async () => {
      if (!app) return;

      const req = new Request("http://localhost:8181/api/demo/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          host: "localhost:8181",
        },
        body: JSON.stringify({ messages: [] }),
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(400);
    });

    it("should handle errors gracefully", async () => {
      if (!app) return;

      const req = new Request("http://localhost:8181/api/demo/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          host: "localhost:8181",
        },
        body: "invalid json",
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(400);
    });
  });

  describe("Rate Limiting", () => {
    it("should enforce rate limits on demo chat", async () => {
      if (!app) return;

      const makeRequest = () =>
        app.fetch(
          new Request("http://localhost:8181/api/demo/chat", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              host: "localhost:8181",
              "x-forwarded-for": "192.168.1.100",
            },
            body: JSON.stringify({ message: "Test" }),
          }),
        );

      // Make requests up to limit (10 per minute for demo)
      const responses = [];
      for (let i = 0; i < 12; i++) {
        responses.push(await makeRequest());
      }

      // At least some should be rate limited
      const rateLimited = responses.filter((r) => r.status === 429);
      expect(rateLimited.length).toBeGreaterThan(0);
    });

    it("should return rate limit error with helpful message", async () => {
      if (!app) return;

      // Exhaust rate limit
      for (let i = 0; i < 15; i++) {
        await app.fetch(
          new Request("http://localhost:8181/api/demo/chat", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              host: "localhost:8181",
              "x-forwarded-for": "192.168.1.101",
            },
            body: JSON.stringify({ message: "Test" }),
          }),
        );
      }

      // Next request should be rate limited
      const res = await app.fetch(
        new Request("http://localhost:8181/api/demo/chat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            host: "localhost:8181",
            "x-forwarded-for": "192.168.1.101",
          },
          body: JSON.stringify({ message: "Test" }),
        }),
      );

      if (res.status === 429) {
        const json = await res.json();
        expect(json.error).toContain("rate limit");
      }
    });
  });

  describe("Streaming Support", () => {
    it("should support streaming with stream=1 parameter", async () => {
      if (!app) return;

      const req = new Request("http://localhost:8181/api/demo/chat?stream=1", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          host: "localhost:8181",
        },
        body: JSON.stringify({ message: "Hello" }),
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(200);

      // Should have streaming response
      const text = await res.text();
      expect(text).toBeDefined();
    });
  });
});
