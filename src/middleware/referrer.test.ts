import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { requireReferrer } from "./referrer";

describe("Referrer Middleware", () => {
  const allowedOrigins = ["http://localhost:8181", "https://example.com"];

  describe("requireReferrer", () => {
    it("should allow requests with valid referer from allowed origin", async () => {
      const app = new Hono();
      app.use("/api/*", requireReferrer(allowedOrigins));
      app.post("/api/test", (c) => c.json({ ok: true }));

      const req = new Request("http://localhost/api/test", {
        method: "POST",
        headers: {
          "x-api-key": "session_test123",
          referer: "http://localhost:8181/page",
        },
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(200);
    });

    it("should allow requests with valid origin header", async () => {
      const app = new Hono();
      app.use("/api/*", requireReferrer(allowedOrigins));
      app.post("/api/test", (c) => c.json({ ok: true }));

      const req = new Request("http://localhost/api/test", {
        method: "POST",
        headers: {
          "x-api-key": "session_test123",
          origin: "https://example.com",
        },
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(200);
    });

    it("should block session keys from disallowed origins", async () => {
      const app = new Hono();
      app.use("/api/*", requireReferrer(allowedOrigins));
      app.post("/api/test", (c) => c.json({ ok: true }));

      const req = new Request("http://localhost/api/test", {
        method: "POST",
        headers: {
          "x-api-key": "session_test123",
          referer: "http://malicious-site.com",
        },
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(403);

      const json = await res.json();
      expect(json.error).toContain("Demo API keys");
    });

    it("should block demo keys from disallowed origins", async () => {
      const app = new Hono();
      app.use("/api/*", requireReferrer(allowedOrigins));
      app.post("/api/test", (c) => c.json({ ok: true }));

      const req = new Request("http://localhost/api/test", {
        method: "POST",
        headers: {
          "x-api-key": "chatter-api-key-here",
          referer: "http://untrusted.com",
        },
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(403);
    });

    it("should allow production API keys from any origin", async () => {
      const app = new Hono();
      app.use("/api/*", requireReferrer(allowedOrigins));
      app.post("/api/test", (c) => c.json({ ok: true }));

      const req = new Request("http://localhost/api/test", {
        method: "POST",
        headers: {
          "x-api-key": "production-api-key-123",
          referer: "http://any-site.com",
        },
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(200);
    });

    it("should check session_ prefix for session keys", async () => {
      const app = new Hono();
      app.use("/api/*", requireReferrer(allowedOrigins));
      app.post("/api/test", (c) => c.json({ ok: true }));

      const req = new Request("http://localhost/api/test", {
        method: "POST",
        headers: {
          "x-api-key": "session_abc123def456",
          referer: "https://example.com/page",
        },
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(200);
    });

    it("should accept requests without api-key header", async () => {
      const app = new Hono();
      app.use("/api/*", requireReferrer(allowedOrigins));
      app.post("/api/test", (c) => c.json({ ok: true }));

      const req = new Request("http://localhost/api/test", {
        method: "POST",
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(200);
    });

    it("should match referer that starts with allowed origin", async () => {
      const app = new Hono();
      app.use("/api/*", requireReferrer(allowedOrigins));
      app.post("/api/test", (c) => c.json({ ok: true }));

      const validReferrers = [
        "http://localhost:8181/",
        "http://localhost:8181/page",
        "http://localhost:8181/deep/nested/page",
        "https://example.com/",
        "https://example.com/path?query=value",
      ];

      for (const referer of validReferrers) {
        const req = new Request("http://localhost/api/test", {
          method: "POST",
          headers: {
            "x-api-key": "session_test",
            referer,
          },
        });

        const res = await app.fetch(req);
        expect(res.status).toBe(200);
      }
    });

    it("should reject referer that does not start with allowed origin", async () => {
      const app = new Hono();
      app.use("/api/*", requireReferrer(allowedOrigins));
      app.post("/api/test", (c) => c.json({ ok: true }));

      const invalidReferrers = [
        "http://localhost:8182/page", // Wrong port
        "https://example.com.evil.com/", // Subdomain attack
        "http://not-allowed.com",
        "https://not-example.com",
      ];

      for (const referer of invalidReferrers) {
        const req = new Request("http://localhost/api/test", {
          method: "POST",
          headers: {
            "x-api-key": "session_test",
            referer,
          },
        });

        const res = await app.fetch(req);
        expect(res.status).toBe(403);
      }
    });

    it("should match exact origin header", async () => {
      const app = new Hono();
      app.use("/api/*", requireReferrer(allowedOrigins));
      app.post("/api/test", (c) => c.json({ ok: true }));

      const validOrigins = ["http://localhost:8181", "https://example.com"];

      for (const origin of validOrigins) {
        const req = new Request("http://localhost/api/test", {
          method: "POST",
          headers: {
            "x-api-key": "session_test",
            origin,
          },
        });

        const res = await app.fetch(req);
        expect(res.status).toBe(200);
      }
    });

    it("should handle missing referer and origin headers for session keys", async () => {
      const app = new Hono();
      app.use("/api/*", requireReferrer(allowedOrigins));
      app.post("/api/test", (c) => c.json({ ok: true }));

      const req = new Request("http://localhost/api/test", {
        method: "POST",
        headers: {
          "x-api-key": "session_test123",
        },
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(403);
    });

    it("should work with multiple allowed origins", async () => {
      const multiOrigins = [
        "http://localhost:3000",
        "http://localhost:8181",
        "https://app.example.com",
        "https://example.com",
      ];

      const app = new Hono();
      app.use("/api/*", requireReferrer(multiOrigins));
      app.post("/api/test", (c) => c.json({ ok: true }));

      for (const origin of multiOrigins) {
        const req = new Request("http://localhost/api/test", {
          method: "POST",
          headers: {
            "x-api-key": "session_test",
            origin,
          },
        });

        const res = await app.fetch(req);
        expect(res.status).toBe(200);
      }
    });

    it("should differentiate between demo key and session key", async () => {
      const app = new Hono();
      app.use("/api/*", requireReferrer(allowedOrigins));
      app.post("/api/test", (c) => c.json({ ok: true }));

      // Demo key should be blocked
      const demoReq = new Request("http://localhost/api/test", {
        method: "POST",
        headers: {
          "x-api-key": "chatter-api-key-here",
          referer: "http://evil.com",
        },
      });
      const demoRes = await app.fetch(demoReq);
      expect(demoRes.status).toBe(403);

      // Session key should also be blocked from same origin
      const sessionReq = new Request("http://localhost/api/test", {
        method: "POST",
        headers: {
          "x-api-key": "session_abc123",
          referer: "http://evil.com",
        },
      });
      const sessionRes = await app.fetch(sessionReq);
      expect(sessionRes.status).toBe(403);
    });
  });
});
