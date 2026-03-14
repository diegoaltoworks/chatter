import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { createSession } from "../core/session";
import { validateSessionKey } from "./session";

describe("Session Middleware", () => {
  describe("validateSessionKey", () => {
    it("should allow requests with valid session key", async () => {
      const app = new Hono();
      app.use("/api/*", validateSessionKey());
      app.post("/api/test", (c) => c.json({ ok: true }));

      const session = createSession({ maxRequests: 5 });

      const req = new Request("http://localhost/api/test", {
        method: "POST",
        headers: {
          "x-api-key": session.key,
        },
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(200);
    });

    it("should reject expired session key", async () => {
      const app = new Hono();
      app.use("/api/*", validateSessionKey());
      app.post("/api/test", (c) => c.json({ ok: true }));

      const session = createSession({ ttl: -1 }); // Expired

      const req = new Request("http://localhost/api/test", {
        method: "POST",
        headers: {
          "x-api-key": session.key,
        },
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(401);

      const json = await res.json();
      expect(json.error).toContain("Session expired");
    });

    it("should reject session key with exceeded quota", async () => {
      const app = new Hono();
      app.use("/api/*", validateSessionKey());
      app.post("/api/test", (c) => c.json({ ok: true }));

      const session = createSession({ maxRequests: 2 });

      // Use up quota
      for (let i = 0; i < 2; i++) {
        const req = new Request("http://localhost/api/test", {
          method: "POST",
          headers: { "x-api-key": session.key },
        });
        await app.fetch(req);
      }

      // This should be rejected
      const req = new Request("http://localhost/api/test", {
        method: "POST",
        headers: { "x-api-key": session.key },
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(401);

      const json = await res.json();
      expect(json.error).toContain("quota exceeded");
    });

    it("should increment request count on each validation", async () => {
      const app = new Hono();
      app.use("/api/*", validateSessionKey());
      app.post("/api/test", (c) => c.json({ ok: true }));

      const session = createSession({ maxRequests: 10 });

      // Make 3 requests
      for (let i = 0; i < 3; i++) {
        const req = new Request("http://localhost/api/test", {
          method: "POST",
          headers: { "x-api-key": session.key },
        });
        const res = await app.fetch(req);
        expect(res.status).toBe(200);
      }

      // Verify count was incremented
      const { getSessionInfo } = await import("../core/session");
      const info = getSessionInfo(session.key);
      expect(info?.requests).toBe(3);
    });

    it("should allow requests without session key prefix", async () => {
      const app = new Hono();
      app.use("/api/*", validateSessionKey());
      app.post("/api/test", (c) => c.json({ ok: true }));

      const req = new Request("http://localhost/api/test", {
        method: "POST",
        headers: {
          "x-api-key": "regular-api-key-123",
        },
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(200);
    });

    it("should allow requests without x-api-key header", async () => {
      const app = new Hono();
      app.use("/api/*", validateSessionKey());
      app.post("/api/test", (c) => c.json({ ok: true }));

      const req = new Request("http://localhost/api/test", {
        method: "POST",
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(200);
    });

    it("should only validate keys with session_ prefix", async () => {
      const app = new Hono();
      app.use("/api/*", validateSessionKey());
      app.post("/api/test", (c) => c.json({ ok: true }));

      const nonSessionKeys = ["api-key-123", "bearer-token", "jwt-token-here", "chatter-api-key"];

      for (const key of nonSessionKeys) {
        const req = new Request("http://localhost/api/test", {
          method: "POST",
          headers: { "x-api-key": key },
        });
        const res = await app.fetch(req);
        expect(res.status).toBe(200);
      }
    });

    it("should reject invalid session key format", async () => {
      const app = new Hono();
      app.use("/api/*", validateSessionKey());
      app.post("/api/test", (c) => c.json({ ok: true }));

      const req = new Request("http://localhost/api/test", {
        method: "POST",
        headers: {
          "x-api-key": "session_invalid_not_found",
        },
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(401);
    });

    it("should work with multiple middleware", async () => {
      const app = new Hono();

      // Add session validation first
      app.use("/api/*", validateSessionKey());

      // Add another middleware
      app.use("/api/*", async (c, next) => {
        c.header("X-Custom", "test");
        await next();
      });

      app.post("/api/test", (c) => c.json({ ok: true }));

      const session = createSession();
      const req = new Request("http://localhost/api/test", {
        method: "POST",
        headers: { "x-api-key": session.key },
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(200);
      expect(res.headers.get("X-Custom")).toBe("test");
    });

    it("should provide helpful error message for expired session", async () => {
      const app = new Hono();
      app.use("/api/*", validateSessionKey());
      app.post("/api/test", (c) => c.json({ ok: true }));

      const session = createSession({ ttl: 0 });
      await new Promise((resolve) => setTimeout(resolve, 10));

      const req = new Request("http://localhost/api/test", {
        method: "POST",
        headers: { "x-api-key": session.key },
      });

      const res = await app.fetch(req);
      const json = await res.json();

      expect(json.error).toContain("refresh the page");
    });

    it("should handle concurrent requests with same session key", async () => {
      const app = new Hono();
      app.use("/api/*", validateSessionKey());
      app.post("/api/test", (c) => c.json({ ok: true }));

      const session = createSession({ maxRequests: 10 });

      // Make 5 concurrent requests
      const requests = Array.from({ length: 5 }, () =>
        app.fetch(
          new Request("http://localhost/api/test", {
            method: "POST",
            headers: { "x-api-key": session.key },
          }),
        ),
      );

      const responses = await Promise.all(requests);

      // All should succeed
      for (const res of responses) {
        expect(res.status).toBe(200);
      }

      // Count should be 5
      const { getSessionInfo } = await import("../core/session");
      const info = getSessionInfo(session.key);
      expect(info?.requests).toBe(5);
    });
  });
});
