/**
 * Integration tests for demo routes
 * Tests session creation, demo chat, and rate limiting
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createServer } from "../../src/server";
import type { ChatterConfig } from "../../src/types";
import {
  type FakeOpenAI,
  type IntegrationDirs,
  installFakeOpenAI,
  integrationConfig,
  setupIntegrationDirs,
} from "./harness";

describe("Demo Routes Integration", () => {
  let dirs: IntegrationDirs;
  let fakeOpenAI: FakeOpenAI;
  let app: Awaited<ReturnType<typeof createServer>>;

  beforeAll(async () => {
    dirs = setupIntegrationDirs("demo-routes");
    fakeOpenAI = installFakeOpenAI({ reply: "Hi there, this is a demo reply." });

    const config: ChatterConfig = integrationConfig(dirs, {
      features: { enablePublicChat: false, enablePrivateChat: false, enableDemoRoutes: true },
      // These tests isolate rate-limit state per test with a distinct
      // X-Forwarded-For, which only partitions requests when trustProxy is on.
      rateLimit: { trustProxy: true },
    });

    app = await createServer(config);
  });

  afterAll(() => {
    fakeOpenAI.restore();
    dirs.cleanup();
  });

  describe("Session Creation", () => {
    it("should create a session key via GET /api/demo/session", async () => {
      const req = new Request("http://localhost:8181/api/demo/session", {
        headers: { host: "localhost:8181" },
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
      const req = new Request("http://localhost:8181/api/demo/session", {
        headers: { host: "localhost:8181" },
      });

      const res = await app.fetch(req);
      const json = await res.json();

      expect(json).toHaveProperty("key");
      expect(json).toHaveProperty("expiresIn");
      expect(json).toHaveProperty("maxRequests");
      expect(json).toHaveProperty("message");
    });

    it("should create unique session keys", async () => {
      const req1 = new Request("http://localhost:8181/api/demo/session", {
        headers: { host: "localhost:8181" },
      });
      const req2 = new Request("http://localhost:8181/api/demo/session", {
        headers: { host: "localhost:8181" },
      });

      const json1 = await (await app.fetch(req1)).json();
      const json2 = await (await app.fetch(req2)).json();

      expect(json1.key).not.toBe(json2.key);
    });
  });

  describe("Demo Stats", () => {
    it("should return active session count", async () => {
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
      const req = new Request("http://localhost:8181/api/demo/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", host: "localhost:8181" },
        body: JSON.stringify({ message: "Hello" }),
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.reply).toBe("Hi there, this is a demo reply.");
    });

    it("should support conversation history", async () => {
      const req = new Request("http://localhost:8181/api/demo/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", host: "localhost:8181" },
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
      const req = new Request("http://localhost:8181/api/demo/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", host: "localhost:8181" },
        body: JSON.stringify({}),
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(400);

      const json = await res.json();
      expect(json.error).toContain("message");
    });

    it("should reject empty messages array", async () => {
      const req = new Request("http://localhost:8181/api/demo/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", host: "localhost:8181" },
        body: JSON.stringify({ messages: [] }),
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(400);
    });

    it("should handle errors gracefully", async () => {
      const req = new Request("http://localhost:8181/api/demo/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", host: "localhost:8181" },
        body: "invalid json",
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(400);
    });
  });

  describe("Rate Limiting", () => {
    it("should enforce rate limits on demo chat", async () => {
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

      // 10 requests per minute for demo; make requests up to and past the limit.
      const responses = [];
      for (let i = 0; i < 12; i++) {
        responses.push(await makeRequest());
      }

      const rateLimited = responses.filter((r) => r.status === 429);
      expect(rateLimited.length).toBeGreaterThan(0);
    });

    it("should return rate limit error with helpful message", async () => {
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

      expect(res.status).toBe(429);
      const json = await res.json();
      expect(json.error).toContain("rate limit");
    });
  });

  describe("Streaming Support", () => {
    it("should support streaming with stream=1 parameter", async () => {
      const req = new Request("http://localhost:8181/api/demo/chat?stream=1", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          host: "localhost:8181",
          // A fresh IP: .100 and .101 were driven past the demo rate limit by
          // the "Rate Limiting" tests above, and the limiter's window outlives
          // this test.
          "x-forwarded-for": "192.168.1.200",
        },
        body: JSON.stringify({ message: "Hello" }),
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(200);

      const text = await res.text();
      expect(text).toContain("data:");
      expect(text).toContain("event: end");
      expect(text).toContain("Hi there, this is a demo reply.");
    });
  });
});
