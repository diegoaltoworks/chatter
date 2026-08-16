/**
 * createServer integration tests: feature flags, CORS, and config wiring.
 *
 * Custom-route mounting, channel lifecycle and auth-secret precedence are
 * covered at the unit level in src/server.test.ts against a faked OpenAI
 * client; this file is about what a full `createServer(config)` call wires
 * up end to end — which routes exist, and what the public config endpoint
 * reports — using the real route stack and an in-memory database.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ApiKeyManager } from "../../src/auth/apikeys";
import { createServer } from "../../src/server";
import type { ChatterConfig } from "../../src/types";
import {
  type FakeOpenAI,
  type IntegrationDirs,
  installFakeOpenAI,
  integrationConfig,
  setupIntegrationDirs,
} from "./harness";

describe("Server Integration", () => {
  let dirs: IntegrationDirs;
  let fakeOpenAI: FakeOpenAI;

  beforeAll(() => {
    dirs = setupIntegrationDirs("server");
    fakeOpenAI = installFakeOpenAI();
  });

  afterAll(() => {
    fakeOpenAI.restore();
    dirs.cleanup();
  });

  afterEach(() => {
    fakeOpenAI.calls.length = 0;
  });

  function config(overrides: Partial<ChatterConfig> = {}): ChatterConfig {
    return integrationConfig(dirs, { features: { headless: true }, ...overrides });
  }

  describe("createServer", () => {
    it("should create server with minimal configuration", async () => {
      const app = await createServer(config());
      expect(app).toBeDefined();
      expect(typeof app.fetch).toBe("function");
    });

    it("should respond to health check", async () => {
      const app = await createServer(config());
      const res = await app.fetch(new Request("http://localhost/healthz"));

      expect(res.status).toBe(200);
      expect(await res.text()).toBe("ok");
    });

    it("should respond to config endpoint with public config", async () => {
      const app = await createServer(
        config({
          branding: { publicPrimaryColor: "#007bff" },
          chat: { publicTitle: "Hello!" },
        }),
      );

      const res = await app.fetch(new Request("http://localhost/config"));

      expect(res.status).toBe(200);
      const json = await res.json();

      expect(json.botName).toBe("TestBot");
      expect(json.publicUrl).toBe("http://localhost:8181");
      expect(json.branding.publicPrimaryColor).toBe("#007bff");
      expect(json.chat.publicTitle).toBe("Hello!");
    });

    it("should enable CORS by default", async () => {
      const app = await createServer(config());
      const res = await app.fetch(new Request("http://localhost/healthz"));

      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    });

    it("should disable CORS when configured", async () => {
      const app = await createServer(config({ server: { cors: false } }));

      const res = await app.fetch(new Request("http://localhost/healthz"));
      expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    });

    it("should enable public chat by default", async () => {
      const app = await createServer(config());

      const res = await app.fetch(
        new Request("http://localhost/api/public/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: "test" }),
        }),
      );

      // No API key configured -> 401, not 404: the route exists.
      expect(res.status).toBe(401);
    });

    it("should disable public chat when configured", async () => {
      const app = await createServer(
        config({ features: { headless: true, enablePublicChat: false } }),
      );

      const res = await app.fetch(
        new Request("http://localhost/api/public/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: "test" }),
        }),
      );

      expect(res.status).toBe(404);
    });

    it("should enable private chat by default", async () => {
      const app = await createServer(
        config({ auth: { jwt: { publicKeyPem: "dummy-key-for-route-check" } } }),
      );

      const res = await app.fetch(
        new Request("http://localhost/api/private/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: "test" }),
        }),
      );

      expect(res.status).toBe(401); // Route exists, auth fails
    });

    it("should disable private chat when configured", async () => {
      const app = await createServer(
        config({ features: { headless: true, enablePrivateChat: false } }),
      );

      const res = await app.fetch(
        new Request("http://localhost/api/private/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: "test" }),
        }),
      );

      expect(res.status).toBe(404);
    });

    it("should enable demo routes when configured", async () => {
      const app = await createServer(
        config({ features: { headless: true, enableDemoRoutes: true } }),
      );

      const res = await app.fetch(
        new Request("http://localhost/api/demo/session", { method: "GET" }),
      );

      expect(res.status).toBe(200);
    });

    it("should not mount demo routes by default", async () => {
      const app = await createServer(config());

      const res = await app.fetch(
        new Request("http://localhost/api/demo/session", { method: "GET" }),
      );

      expect(res.status).toBe(404);
    });

    it("should initialize API key manager when secret is provided", async () => {
      const secret = "test-secret-key-long-enough";
      const app = await createServer(config({ auth: { secret } }));

      // A key minted with the SAME secret authenticates; one signed with a
      // different secret doesn't - proving the manager was actually wired to
      // this secret, not merely constructed.
      const validKey = await new ApiKeyManager(secret).create();
      const wrongKey = await new ApiKeyManager("a-different-secret-value").create();

      const request = (apiKey: string) =>
        app.fetch(
          new Request("http://localhost/api/public/chat", {
            method: "POST",
            headers: { "content-type": "application/json", "x-api-key": apiKey },
            body: JSON.stringify({ message: "test" }),
          }),
        );

      expect((await request(validKey)).status).toBe(200);
      expect((await request(wrongKey)).status).toBe(401);
    });

    it("should load knowledge from a custom directory", async () => {
      const knowledgeDir = join(dirs.knowledgeDir, "..", "custom-knowledge");
      await mkdir(join(knowledgeDir, "base"), { recursive: true });
      await writeFile(join(knowledgeDir, "base", "test.md"), "# Test Knowledge\nCustom content.");

      await createServer(config({ knowledgeDir }));

      // Server boot embeds every knowledge chunk - proving THIS directory (not
      // the shared fixture one) was what got loaded and built.
      const embedded = fakeOpenAI.calls.find(
        (c) =>
          c.path === "/v1/embeddings" &&
          Array.isArray(c.body?.input) &&
          (c.body.input as string[]).some((text) => text.includes("Custom content.")),
      );
      expect(embedded).toBeDefined();
    });

    it("should load custom prompts from a directory", async () => {
      const promptsDir = join(dirs.promptsDir, "..", "custom-prompts");
      await mkdir(promptsDir, { recursive: true });
      await writeFile(join(promptsDir, "base.txt"), "Custom system rules.");
      await writeFile(join(promptsDir, "public.txt"), "Custom public persona.");
      await writeFile(join(promptsDir, "private.txt"), "Custom private persona.");

      const key = await new ApiKeyManager("test-secret-key-long-enough").create();
      const app = await createServer(
        config({ promptsDir, auth: { secret: "test-secret-key-long-enough" } }),
      );

      const res = await app.fetch(
        new Request("http://localhost/api/public/chat", {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": key },
          body: JSON.stringify({ message: "test" }),
        }),
      );
      expect(res.status).toBe(200);

      // The chat call the fake answered carries the custom prompt text -
      // proving THIS directory, not the shared fixture one, was loaded.
      const completion = fakeOpenAI.calls.find((c) => c.path === "/v1/chat/completions");
      const systemMessage = (
        completion?.body?.messages as Array<{ role: string; content: string }> | undefined
      )?.find((m) => m.role === "system");
      expect(systemMessage?.content).toContain("Custom system rules.");
    });
  });
});
