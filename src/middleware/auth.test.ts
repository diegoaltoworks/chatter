import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { ApiKeyManager } from "../auth/apikeys";
import { createSession } from "../core/session";
import type { ServerDependencies } from "../types";
import { createAuthMiddleware } from "./auth";

describe("Auth Middleware", () => {
  const testSecret = "test-secret-for-auth-middleware-testing";

  describe("createAuthMiddleware", () => {
    it("should create middleware function", () => {
      const apiKeyManager = new ApiKeyManager(testSecret);
      const deps: Partial<ServerDependencies> = { apiKeyManager };

      const middleware = createAuthMiddleware(deps as ServerDependencies);

      expect(middleware).toBeDefined();
      expect(typeof middleware).toBe("function");
    });

    it("should reject request without API key", async () => {
      const apiKeyManager = new ApiKeyManager(testSecret);
      const deps: Partial<ServerDependencies> = { apiKeyManager };

      const app = new Hono();
      app.use("/api/*", createAuthMiddleware(deps as ServerDependencies));
      app.post("/api/test", (c) => c.json({ ok: true }));

      const req = new Request("http://localhost/api/test", {
        method: "POST",
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(401);

      const json = await res.json();
      expect(json.error).toContain("x-api-key");
    });

    it("should reject request with invalid API key", async () => {
      const apiKeyManager = new ApiKeyManager(testSecret);
      const deps: Partial<ServerDependencies> = { apiKeyManager };

      const app = new Hono();
      app.use("/api/*", createAuthMiddleware(deps as ServerDependencies));
      app.post("/api/test", (c) => c.json({ ok: true }));

      const req = new Request("http://localhost/api/test", {
        method: "POST",
        headers: {
          "x-api-key": "invalid-key-format",
        },
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(401);
    });

    it("should accept request with valid JWT API key", async () => {
      const apiKeyManager = new ApiKeyManager(testSecret);
      const validKey = await apiKeyManager.create({ name: "test-app" });
      const deps: Partial<ServerDependencies> = { apiKeyManager };

      const app = new Hono();
      app.use("/api/*", createAuthMiddleware(deps as ServerDependencies));
      app.post("/api/test", (c) => c.json({ ok: true }));

      const req = new Request("http://localhost/api/test", {
        method: "POST",
        headers: {
          "x-api-key": validKey,
        },
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(200);
    });

    it("should accept request with session key", async () => {
      const apiKeyManager = new ApiKeyManager(testSecret);
      const session = createSession();
      const deps: Partial<ServerDependencies> = { apiKeyManager };

      const app = new Hono();
      app.use("/api/*", createAuthMiddleware(deps as ServerDependencies));
      app.post("/api/test", (c) => c.json({ ok: true }));

      const req = new Request("http://localhost/api/test", {
        method: "POST",
        headers: {
          "x-api-key": session.key,
        },
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(200);
    });

    it("should allow session keys to bypass JWT verification", async () => {
      // Session keys should pass through without JWT verification
      const apiKeyManager = new ApiKeyManager(testSecret);
      const session = createSession();
      const deps: Partial<ServerDependencies> = { apiKeyManager };

      const app = new Hono();
      app.use("/api/*", createAuthMiddleware(deps as ServerDependencies));
      app.post("/api/test", (c) => c.json({ ok: true }));

      const req = new Request("http://localhost/api/test", {
        method: "POST",
        headers: {
          "x-api-key": session.key,
        },
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(200);
    });

    it("should reject expired JWT API key", async () => {
      const apiKeyManager = new ApiKeyManager(testSecret);
      const expiredKey = await apiKeyManager.create({ expiresIn: "1s" });

      // Wait for expiration
      await new Promise((resolve) => setTimeout(resolve, 1100));

      const deps: Partial<ServerDependencies> = { apiKeyManager };

      const app = new Hono();
      app.use("/api/*", createAuthMiddleware(deps as ServerDependencies));
      app.post("/api/test", (c) => c.json({ ok: true }));

      const req = new Request("http://localhost/api/test", {
        method: "POST",
        headers: {
          "x-api-key": expiredKey,
        },
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(401);
    });

    it("should reject JWT from wrong secret", async () => {
      const otherManager = new ApiKeyManager("different-secret");
      const otherKey = await otherManager.create();

      const apiKeyManager = new ApiKeyManager(testSecret);
      const deps: Partial<ServerDependencies> = { apiKeyManager };

      const app = new Hono();
      app.use("/api/*", createAuthMiddleware(deps as ServerDependencies));
      app.post("/api/test", (c) => c.json({ ok: true }));

      const req = new Request("http://localhost/api/test", {
        method: "POST",
        headers: {
          "x-api-key": otherKey,
        },
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(401);
    });

    it("should return error when no API key manager configured", async () => {
      const deps: Partial<ServerDependencies> = { apiKeyManager: undefined };

      const app = new Hono();
      app.use("/api/*", createAuthMiddleware(deps as ServerDependencies));
      app.post("/api/test", (c) => c.json({ ok: true }));

      const req = new Request("http://localhost/api/test", {
        method: "POST",
        headers: {
          "x-api-key": "any-key",
        },
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(401);

      const json = await res.json();
      expect(json.error).toContain("not configured");
    });

    it("should work with multiple middleware in chain", async () => {
      const apiKeyManager = new ApiKeyManager(testSecret);
      const validKey = await apiKeyManager.create();
      const deps: Partial<ServerDependencies> = { apiKeyManager };

      const app = new Hono();

      // Add custom middleware before auth
      app.use("/api/*", async (c, next) => {
        c.header("X-Custom", "value");
        await next();
      });

      app.use("/api/*", createAuthMiddleware(deps as ServerDependencies));
      app.post("/api/test", (c) => c.json({ ok: true }));

      const req = new Request("http://localhost/api/test", {
        method: "POST",
        headers: {
          "x-api-key": validKey,
        },
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(200);
      expect(res.headers.get("X-Custom")).toBe("value");
    });

    it("should stop middleware chain on auth failure", async () => {
      const apiKeyManager = new ApiKeyManager(testSecret);
      const deps: Partial<ServerDependencies> = { apiKeyManager };

      let nextCalled = false;

      const app = new Hono();
      app.use("/api/*", createAuthMiddleware(deps as ServerDependencies));
      app.use("/api/*", async (c, next) => {
        nextCalled = true;
        await next();
      });
      app.post("/api/test", (c) => c.json({ ok: true }));

      const req = new Request("http://localhost/api/test", {
        method: "POST",
        headers: {
          "x-api-key": "invalid",
        },
      });

      await app.fetch(req);
      expect(nextCalled).toBe(false);
    });

    it("should allow custom API key manager implementation", async () => {
      const customManager = {
        verify: async (token: string) => {
          if (token === "custom-valid-key") {
            return { valid: true, payload: { custom: true } };
          }
          return { valid: false, error: "Invalid custom key" };
        },
      };

      const deps: Partial<ServerDependencies> = {
        apiKeyManager: customManager as unknown as ApiKeyManager,
      };

      const app = new Hono();
      app.use("/api/*", createAuthMiddleware(deps as ServerDependencies));
      app.post("/api/test", (c) => c.json({ ok: true }));

      const validReq = new Request("http://localhost/api/test", {
        method: "POST",
        headers: { "x-api-key": "custom-valid-key" },
      });

      const validRes = await app.fetch(validReq);
      expect(validRes.status).toBe(200);

      const invalidReq = new Request("http://localhost/api/test", {
        method: "POST",
        headers: { "x-api-key": "custom-invalid-key" },
      });

      const invalidRes = await app.fetch(invalidReq);
      expect(invalidRes.status).toBe(401);
    });
  });
});
