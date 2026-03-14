import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../../src";
import type { ChatterConfig } from "../../src/types";

describe("Server Integration", () => {
  // Skip tests if no OpenAI API key or Turso URL
  if (!process.env.OPENAI_API_KEY || !process.env.TURSO_URL) {
    it.skip("requires OPENAI_API_KEY and TURSO_URL to run", () => {});
    return;
  }

  let testDir: string;

  beforeAll(async () => {
    testDir = await mkdtemp(join(tmpdir(), "chatter-server-test-"));
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  // Helper function to create base config
  function createTestConfig(overrides?: Partial<ChatterConfig>): ChatterConfig {
    return {
      bot: {
        name: "Test Bot",
        personName: "Test Person",
        publicUrl: "http://localhost:3000",
        description: "Test bot description",
      },
      openai: {
        apiKey: process.env.OPENAI_API_KEY!,
      },
      database: {
        url: process.env.TURSO_URL!,
        authToken: process.env.TURSO_AUTH_TOKEN || "",
      },
      ...overrides,
    };
  }

  describe("createServer", () => {
    it("should create server with minimal configuration", async () => {
      const app = await createServer(createTestConfig());
      expect(app).toBeDefined();
      expect(typeof app.fetch).toBe("function");
    });

    it("should respond to health check", async () => {
      const app = await createServer(createTestConfig());
      const res = await app.fetch(new Request("http://localhost/healthz"));

      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toBe("ok");
    });

    it("should respond to config endpoint with public config", async () => {
      const app = await createServer(
        createTestConfig({
          branding: { publicPrimaryColor: "#007bff" },
          chat: { publicTitle: "Hello!" },
        })
      );

      const res = await app.fetch(new Request("http://localhost/config"));

      expect(res.status).toBe(200);
      const json = await res.json();

      expect(json.botName).toBe("Test Bot");
      expect(json.publicUrl).toBe("http://localhost:3000");
      expect(json.branding.publicPrimaryColor).toBe("#007bff");
      expect(json.chat.publicTitle).toBe("Hello!");
    });

    it("should enable CORS by default", async () => {
      const app = await createServer(createTestConfig());
      const res = await app.fetch(new Request("http://localhost/healthz"));

      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    });

    it("should disable CORS when configured", async () => {
      const app = await createServer(
        createTestConfig({
          server: { cors: false },
        })
      );

      const res = await app.fetch(new Request("http://localhost/healthz"));
      expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    });

    it("should enable public chat by default", async () => {
      const app = await createServer(createTestConfig());

      // Create session first
      const sessionRes = await app.fetch(
        new Request("http://localhost/api/session", {
          method: "POST",
        })
      );
      const session = await sessionRes.json();

      // Try to access public chat
      const res = await app.fetch(
        new Request("http://localhost/api/chat", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": session.key,
          },
          body: JSON.stringify({ message: "test" }),
        })
      );

      expect([200, 429]).toContain(res.status);
    });

    it("should disable public chat when configured", async () => {
      const app = await createServer(
        createTestConfig({
          features: { enablePublicChat: false },
        })
      );

      const res = await app.fetch(
        new Request("http://localhost/api/chat", {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({ message: "test" }),
        })
      );

      expect(res.status).toBe(404);
    });

    it("should enable private chat by default", async () => {
      const app = await createServer(
        createTestConfig({
          auth: {
            jwt: { publicKeyPem: "dummy-key-for-route-check" },
          },
        })
      );

      // Try to access private chat (should get 401, not 404)
      const res = await app.fetch(
        new Request("http://localhost/api/private/chat", {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({ message: "test" }),
        })
      );

      expect(res.status).toBe(401); // Route exists, auth fails
    });

    it("should disable private chat when configured", async () => {
      const app = await createServer(
        createTestConfig({
          features: { enablePrivateChat: false },
        })
      );

      const res = await app.fetch(
        new Request("http://localhost/api/private/chat", {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({ message: "test" }),
        })
      );

      expect(res.status).toBe(404);
    });

    it("should enable demo routes when configured", async () => {
      const app = await createServer(
        createTestConfig({
          features: { enableDemoRoutes: true },
        })
      );

      // Demo session endpoint should exist
      const res = await app.fetch(
        new Request("http://localhost/api/demo/session", {
          method: "POST",
        })
      );

      expect([200, 201]).toContain(res.status);
    });

    it("should initialize API key manager when secret is provided", async () => {
      const app = await createServer(
        createTestConfig({
          auth: { secret: "test-secret-key" },
        })
      );

      expect(app).toBeDefined();
    });

    it("should load knowledge from custom directory", async () => {
      const knowledgeDir = join(testDir, "custom-knowledge");
      await mkdir(knowledgeDir, { recursive: true });
      await writeFile(
        join(knowledgeDir, "test.md"),
        "# Test Knowledge\\nThis is test knowledge content."
      );

      const app = await createServer(
        createTestConfig({ knowledgeDir })
      );

      expect(app).toBeDefined();
    });

    it("should support custom routes via config", async () => {
      const app = await createServer(
        createTestConfig({
          customRoutes: (app, deps) => {
            app.get("/custom/test", (c) => c.json({ custom: true }));
          },
        })
      );

      const res = await app.fetch(new Request("http://localhost/custom/test"));

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.custom).toBe(true);
    });

    it("should handle rate limiting configuration", async () => {
      const app = await createServer(
        createTestConfig({
          rateLimit: {
            public: 5,
          },
        })
      );

      expect(app).toBeDefined();
    });

    it("should load custom prompts from directory", async () => {
      const promptsDir = join(testDir, "custom-prompts");
      await mkdir(promptsDir, { recursive: true });
      await writeFile(
        join(promptsDir, "base.txt"),
        "Custom system rules."
      );

      const app = await createServer(
        createTestConfig({ promptsDir })
      );

      expect(app).toBeDefined();
    });
  });
});
