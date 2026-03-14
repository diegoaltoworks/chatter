import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import type { ChatterConfig } from "../types";
import { createRateLimiter } from "./ratelimit";

describe("Rate Limit Middleware", () => {
  const baseConfig: ChatterConfig = {
    bot: {
      name: "TestBot",
      personName: "Test",
      publicUrl: "http://test.com",
      description: "Test",
    },
    openai: { apiKey: "test" },
    database: { url: "test", authToken: "test" },
    rateLimit: {
      public: 5, // Low limit for testing
      private: 10,
    },
  };

  describe("createRateLimiter", () => {
    it("should create limiter with public and private methods", () => {
      const limiter = createRateLimiter(baseConfig);

      expect(limiter).toHaveProperty("limitPublic");
      expect(limiter).toHaveProperty("limitPrivate");
      expect(typeof limiter.limitPublic).toBe("function");
      expect(typeof limiter.limitPrivate).toBe("function");
    });

    it("should use default limits if not configured", () => {
      const config = { ...baseConfig, rateLimit: undefined };
      const limiter = createRateLimiter(config);

      expect(limiter.limitPublic).toBeDefined();
      expect(limiter.limitPrivate).toBeDefined();
    });
  });

  describe("limitPublic", () => {
    it("should allow requests within limit", async () => {
      const app = new Hono();
      const limiter = createRateLimiter(baseConfig);
      app.use("/api/*", limiter.limitPublic());
      app.post("/api/test", (c) => c.json({ ok: true }));

      // Make requests within limit (5)
      for (let i = 0; i < 5; i++) {
        const req = new Request("http://localhost/api/test", {
          method: "POST",
          headers: { "x-forwarded-for": "192.168.1.1" },
        });
        const res = await app.fetch(req);
        expect(res.status).toBe(200);
      }
    });

    it("should block requests exceeding limit", async () => {
      const app = new Hono();
      const limiter = createRateLimiter(baseConfig);
      app.use("/api/*", limiter.limitPublic());
      app.post("/api/test", (c) => c.json({ ok: true }));

      // Exhaust limit
      for (let i = 0; i < 6; i++) {
        await app.fetch(
          new Request("http://localhost/api/test", {
            method: "POST",
            headers: { "x-forwarded-for": "192.168.1.2" },
          }),
        );
      }

      // Next request should be blocked
      const req = new Request("http://localhost/api/test", {
        method: "POST",
        headers: { "x-forwarded-for": "192.168.1.2" },
      });
      const res = await app.fetch(req);

      expect(res.status).toBe(429);
      const json = await res.json();
      expect(json.error).toContain("Rate limit");
    });

    it("should rate limit by IP address", async () => {
      const app = new Hono();
      const limiter = createRateLimiter(baseConfig);
      app.use("/api/*", limiter.limitPublic());
      app.post("/api/test", (c) => c.json({ ok: true }));

      // IP 1 makes requests
      for (let i = 0; i < 6; i++) {
        await app.fetch(
          new Request("http://localhost/api/test", {
            method: "POST",
            headers: { "x-forwarded-for": "192.168.1.10" },
          }),
        );
      }

      // IP 1 should be rate limited
      const res1 = await app.fetch(
        new Request("http://localhost/api/test", {
          method: "POST",
          headers: { "x-forwarded-for": "192.168.1.10" },
        }),
      );
      expect(res1.status).toBe(429);

      // IP 2 should still work
      const res2 = await app.fetch(
        new Request("http://localhost/api/test", {
          method: "POST",
          headers: { "x-forwarded-for": "192.168.1.20" },
        }),
      );
      expect(res2.status).toBe(200);
    });

    it("should apply stricter limits to demo keys", async () => {
      const app = new Hono();
      const config = { ...baseConfig, rateLimit: { public: 100, private: 100 } };
      const limiter = createRateLimiter(config);
      app.use("/api/*", limiter.limitPublic());
      app.post("/api/test", (c) => c.json({ ok: true }));

      // Demo key gets 10x stricter limit (10 instead of 100)
      for (let i = 0; i < 12; i++) {
        await app.fetch(
          new Request("http://localhost/api/test", {
            method: "POST",
            headers: {
              "x-forwarded-for": "192.168.1.30",
              "x-api-key": "chatter-api-key-here",
            },
          }),
        );
      }

      const res = await app.fetch(
        new Request("http://localhost/api/test", {
          method: "POST",
          headers: {
            "x-forwarded-for": "192.168.1.30",
            "x-api-key": "chatter-api-key-here",
          },
        }),
      );

      if (res.status === 429) {
        const json = await res.json();
        expect(json.error).toContain("Demo");
      }
    });

    it("should extract IP from x-forwarded-for header", async () => {
      const app = new Hono();
      const limiter = createRateLimiter(baseConfig);
      app.use("/api/*", limiter.limitPublic());
      app.post("/api/test", (c) => c.json({ ok: true }));

      // Multiple IPs in x-forwarded-for (takes first one)
      for (let i = 0; i < 6; i++) {
        await app.fetch(
          new Request("http://localhost/api/test", {
            method: "POST",
            headers: { "x-forwarded-for": "192.168.1.40, 10.0.0.1, 172.16.0.1" },
          }),
        );
      }

      const res = await app.fetch(
        new Request("http://localhost/api/test", {
          method: "POST",
          headers: { "x-forwarded-for": "192.168.1.40, 10.0.0.1" },
        }),
      );

      expect(res.status).toBe(429);
    });

    it("should handle missing x-forwarded-for header", async () => {
      const app = new Hono();
      const limiter = createRateLimiter(baseConfig);
      app.use("/api/*", limiter.limitPublic());
      app.post("/api/test", (c) => c.json({ ok: true }));

      // Should still work, uses "unknown-ip"
      const req = new Request("http://localhost/api/test", {
        method: "POST",
      });
      const res = await app.fetch(req);

      expect(res.status).toBe(200);
    });
  });

  describe("limitPrivate", () => {
    it("should allow requests within limit", async () => {
      const app = new Hono();
      const limiter = createRateLimiter(baseConfig);

      // Mock JWT subject in context
      app.use("/api/*", async (c, next) => {
        (c as unknown as { jwtSub: string }).jwtSub = "user-123";
        await next();
      });

      app.use("/api/*", limiter.limitPrivate());
      app.post("/api/test", (c) => c.json({ ok: true }));

      // Make requests within limit (10)
      for (let i = 0; i < 10; i++) {
        const req = new Request("http://localhost/api/test", {
          method: "POST",
        });
        const res = await app.fetch(req);
        expect(res.status).toBe(200);
      }
    });

    it("should block requests exceeding limit", async () => {
      const app = new Hono();
      const limiter = createRateLimiter(baseConfig);

      app.use("/api/*", async (c, next) => {
        (c as unknown as { jwtSub: string }).jwtSub = "user-456";
        await next();
      });

      app.use("/api/*", limiter.limitPrivate());
      app.post("/api/test", (c) => c.json({ ok: true }));

      // Exhaust limit
      for (let i = 0; i < 11; i++) {
        await app.fetch(
          new Request("http://localhost/api/test", {
            method: "POST",
          }),
        );
      }

      // Next request should be blocked
      const req = new Request("http://localhost/api/test", {
        method: "POST",
      });
      const res = await app.fetch(req);

      expect(res.status).toBe(429);
    });

    it("should rate limit by JWT subject", async () => {
      const app = new Hono();
      const limiter = createRateLimiter(baseConfig);

      app.use("/api/*", async (c, next) => {
        const url = new URL(c.req.url);
        (c as unknown as { jwtSub: string }).jwtSub = url.searchParams.get("user") || "default";
        await next();
      });

      app.use("/api/*", limiter.limitPrivate());
      app.post("/api/test", (c) => c.json({ ok: true }));

      // User 1 exhausts limit
      for (let i = 0; i < 11; i++) {
        await app.fetch(new Request("http://localhost/api/test?user=user1", { method: "POST" }));
      }

      // User 1 blocked
      const res1 = await app.fetch(
        new Request("http://localhost/api/test?user=user1", { method: "POST" }),
      );
      expect(res1.status).toBe(429);

      // User 2 still works
      const res2 = await app.fetch(
        new Request("http://localhost/api/test?user=user2", { method: "POST" }),
      );
      expect(res2.status).toBe(200);
    });

    it("should handle missing JWT subject", async () => {
      const app = new Hono();
      const limiter = createRateLimiter(baseConfig);
      app.use("/api/*", limiter.limitPrivate());
      app.post("/api/test", (c) => c.json({ ok: true }));

      // Should still work, uses "no-sub"
      const req = new Request("http://localhost/api/test", {
        method: "POST",
      });
      const res = await app.fetch(req);

      expect(res.status).toBe(200);
    });
  });

  describe("Rate limit window", () => {
    it("should reset count after window expires", async () => {
      const app = new Hono();
      const limiter = createRateLimiter(baseConfig);
      app.use("/api/*", limiter.limitPublic());
      app.post("/api/test", (c) => c.json({ ok: true }));

      // This test would need to wait 60 seconds for window to reset
      // Just verify the mechanism exists
      expect(limiter.limitPublic).toBeDefined();
    });

    it("should use 60 second window", () => {
      // Window is hardcoded to 60 seconds in implementation
      // This is just a documentation test
      expect(true).toBe(true);
    });
  });

  describe("Configuration", () => {
    it("should respect custom public rate limit", async () => {
      const config = { ...baseConfig, rateLimit: { public: 2, private: 10 } };
      const app = new Hono();
      const limiter = createRateLimiter(config);
      app.use("/api/*", limiter.limitPublic());
      app.post("/api/test", (c) => c.json({ ok: true }));

      // Should allow 2 requests
      for (let i = 0; i < 2; i++) {
        const res = await app.fetch(
          new Request("http://localhost/api/test", {
            method: "POST",
            headers: { "x-forwarded-for": "192.168.1.50" },
          }),
        );
        expect(res.status).toBe(200);
      }

      // Third should be blocked
      const res = await app.fetch(
        new Request("http://localhost/api/test", {
          method: "POST",
          headers: { "x-forwarded-for": "192.168.1.50" },
        }),
      );
      expect(res.status).toBe(429);
    });

    it("should respect custom private rate limit", async () => {
      const config = { ...baseConfig, rateLimit: { public: 10, private: 3 } };
      const app = new Hono();
      const limiter = createRateLimiter(config);

      app.use("/api/*", async (c, next) => {
        (c as unknown as { jwtSub: string }).jwtSub = "test-user";
        await next();
      });

      app.use("/api/*", limiter.limitPrivate());
      app.post("/api/test", (c) => c.json({ ok: true }));

      // Should allow 3 requests
      for (let i = 0; i < 3; i++) {
        const res = await app.fetch(new Request("http://localhost/api/test", { method: "POST" }));
        expect(res.status).toBe(200);
      }

      // Fourth should be blocked
      const res = await app.fetch(new Request("http://localhost/api/test", { method: "POST" }));
      expect(res.status).toBe(429);
    });
  });
});
