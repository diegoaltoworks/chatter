import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { cors } from "./cors";

describe("CORS Middleware", () => {
  describe("cors (no origins – default allow all)", () => {
    it("should set CORS headers on GET requests", async () => {
      const app = new Hono();
      app.use("*", cors());
      app.get("/test", (c) => c.text("ok"));

      const req = new Request("http://localhost/test");
      const res = await app.fetch(req);

      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      expect(res.headers.get("access-control-allow-headers")).toContain("content-type");
      expect(res.headers.get("access-control-allow-headers")).toContain("x-api-key");
      expect(res.headers.get("access-control-allow-headers")).toContain("authorization");
      expect(res.headers.get("access-control-allow-methods")).toContain("POST");
      expect(res.headers.get("access-control-allow-methods")).toContain("GET");
    });

    it("should set CORS headers on POST requests", async () => {
      const app = new Hono();
      app.use("*", cors());
      app.post("/test", (c) => c.json({ ok: true }));

      const req = new Request("http://localhost/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: "test" }),
      });
      const res = await app.fetch(req);

      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      expect(res.headers.get("access-control-allow-headers")).toBeDefined();
      expect(res.headers.get("access-control-allow-methods")).toBeDefined();
    });

    it("should handle OPTIONS preflight requests", async () => {
      const app = new Hono();
      app.use("*", cors());
      app.post("/test", (c) => c.json({ ok: true }));

      const req = new Request("http://localhost/test", {
        method: "OPTIONS",
      });
      const res = await app.fetch(req);

      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      expect(res.headers.get("access-control-allow-headers")).toContain("content-type");
      expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    });

    it("should return empty body for OPTIONS requests", async () => {
      const app = new Hono();
      app.use("*", cors());
      app.post("/test", (c) => c.json({ ok: true }));

      const req = new Request("http://localhost/test", {
        method: "OPTIONS",
      });
      const res = await app.fetch(req);

      const text = await res.text();
      expect(text).toBe("");
    });

    it("should allow all origins with *", async () => {
      const app = new Hono();
      app.use("*", cors());
      app.get("/test", (c) => c.text("ok"));

      const origins = [
        "http://example.com",
        "https://example.com",
        "http://localhost:3000",
        "https://app.domain.com",
      ];

      for (const origin of origins) {
        const req = new Request("http://localhost/test", {
          headers: { Origin: origin },
        });
        const res = await app.fetch(req);

        expect(res.headers.get("access-control-allow-origin")).toBe("*");
      }
    });

    it("should work with multiple routes", async () => {
      const app = new Hono();
      app.use("*", cors());
      app.get("/route1", (c) => c.text("route1"));
      app.get("/route2", (c) => c.text("route2"));
      app.post("/route3", (c) => c.json({ route: 3 }));

      const routes = ["/route1", "/route2", "/route3"];

      for (const route of routes) {
        const method = route === "/route3" ? "POST" : "GET";
        const req = new Request(`http://localhost${route}`, { method });
        const res = await app.fetch(req);

        expect(res.headers.get("access-control-allow-origin")).toBe("*");
      }
    });

    it("should allow x-api-key header", async () => {
      const app = new Hono();
      app.use("*", cors());
      app.get("/test", (c) => c.text("ok"));

      const req = new Request("http://localhost/test");
      const res = await app.fetch(req);

      const allowedHeaders = res.headers.get("access-control-allow-headers");
      expect(allowedHeaders).toContain("x-api-key");
    });

    it("should allow authorization header", async () => {
      const app = new Hono();
      app.use("*", cors());
      app.get("/test", (c) => c.text("ok"));

      const req = new Request("http://localhost/test");
      const res = await app.fetch(req);

      const allowedHeaders = res.headers.get("access-control-allow-headers");
      expect(allowedHeaders).toContain("authorization");
    });

    it("should allow content-type header", async () => {
      const app = new Hono();
      app.use("*", cors());
      app.get("/test", (c) => c.text("ok"));

      const req = new Request("http://localhost/test");
      const res = await app.fetch(req);

      const allowedHeaders = res.headers.get("access-control-allow-headers");
      expect(allowedHeaders).toContain("content-type");
    });

    it("should allow POST, GET, and OPTIONS methods", async () => {
      const app = new Hono();
      app.use("*", cors());
      app.get("/test", (c) => c.text("ok"));

      const req = new Request("http://localhost/test");
      const res = await app.fetch(req);

      const allowedMethods = res.headers.get("access-control-allow-methods");
      expect(allowedMethods).toContain("POST");
      expect(allowedMethods).toContain("GET");
      expect(allowedMethods).toContain("OPTIONS");
    });

    it("should not interfere with response body", async () => {
      const app = new Hono();
      app.use("*", cors());
      app.get("/test", (c) => c.json({ message: "test data" }));

      const req = new Request("http://localhost/test");
      const res = await app.fetch(req);

      const json = await res.json();
      expect(json).toEqual({ message: "test data" });
    });

    it("should work with error responses", async () => {
      const app = new Hono();
      app.use("*", cors());
      app.get("/error", (c) => c.json({ error: "Not found" }, 404));

      const req = new Request("http://localhost/error");
      const res = await app.fetch(req);

      expect(res.status).toBe(404);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
    });

    it("should treat explicit ['*'] the same as no origins", async () => {
      const app = new Hono();
      app.use("*", cors(["*"]));
      app.get("/test", (c) => c.text("ok"));

      const req = new Request("http://localhost/test", {
        headers: { Origin: "https://anything.com" },
      });
      const res = await app.fetch(req);

      expect(res.headers.get("access-control-allow-origin")).toBe("*");
    });
  });

  describe("cors (specific allowed origins)", () => {
    const allowed = ["https://myapp.com", "https://staging.myapp.com"];

    it("should echo back a matching origin", async () => {
      const app = new Hono();
      app.use("*", cors(allowed));
      app.get("/test", (c) => c.text("ok"));

      const req = new Request("http://localhost/test", {
        headers: { Origin: "https://myapp.com" },
      });
      const res = await app.fetch(req);

      expect(res.headers.get("access-control-allow-origin")).toBe("https://myapp.com");
    });

    it("should set Vary header when origins are restricted", async () => {
      const app = new Hono();
      app.use("*", cors(allowed));
      app.get("/test", (c) => c.text("ok"));

      const req = new Request("http://localhost/test", {
        headers: { Origin: "https://myapp.com" },
      });
      const res = await app.fetch(req);

      expect(res.headers.get("vary")).toBe("Origin");
    });

    it("should not set Vary header when all origins are allowed", async () => {
      const app = new Hono();
      app.use("*", cors());
      app.get("/test", (c) => c.text("ok"));

      const req = new Request("http://localhost/test", {
        headers: { Origin: "https://whatever.com" },
      });
      const res = await app.fetch(req);

      expect(res.headers.get("vary")).toBeNull();
    });

    it("should return first allowed origin when request origin does not match", async () => {
      const app = new Hono();
      app.use("*", cors(allowed));
      app.get("/test", (c) => c.text("ok"));

      const req = new Request("http://localhost/test", {
        headers: { Origin: "https://evil.com" },
      });
      const res = await app.fetch(req);

      // Browser will reject because response origin doesn't match request origin
      expect(res.headers.get("access-control-allow-origin")).toBe("https://myapp.com");
    });

    it("should handle OPTIONS preflight with matching origin", async () => {
      const app = new Hono();
      app.use("*", cors(allowed));
      app.post("/test", (c) => c.json({ ok: true }));

      const req = new Request("http://localhost/test", {
        method: "OPTIONS",
        headers: { Origin: "https://staging.myapp.com" },
      });
      const res = await app.fetch(req);

      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe("https://staging.myapp.com");
      expect(res.headers.get("vary")).toBe("Origin");
    });

    it("should handle OPTIONS preflight with non-matching origin", async () => {
      const app = new Hono();
      app.use("*", cors(allowed));
      app.post("/test", (c) => c.json({ ok: true }));

      const req = new Request("http://localhost/test", {
        method: "OPTIONS",
        headers: { Origin: "https://evil.com" },
      });
      const res = await app.fetch(req);

      expect(res.status).toBe(204);
      // Falls back to first allowed origin – browser will reject the mismatch
      expect(res.headers.get("access-control-allow-origin")).toBe("https://myapp.com");
    });

    it("should echo correct origin from multiple allowed origins", async () => {
      const app = new Hono();
      app.use("*", cors(allowed));
      app.get("/test", (c) => c.text("ok"));

      for (const origin of allowed) {
        const req = new Request("http://localhost/test", {
          headers: { Origin: origin },
        });
        const res = await app.fetch(req);
        expect(res.headers.get("access-control-allow-origin")).toBe(origin);
      }
    });

    it("should return first allowed origin when no Origin header is sent", async () => {
      const app = new Hono();
      app.use("*", cors(allowed));
      app.get("/test", (c) => c.text("ok"));

      const req = new Request("http://localhost/test");
      const res = await app.fetch(req);

      expect(res.headers.get("access-control-allow-origin")).toBe("https://myapp.com");
    });
  });
});
