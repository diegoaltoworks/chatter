import { afterEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import type { ChatterConfig } from "../types";
import { securityHeaders } from "./securityHeaders";

const baseConfig: ChatterConfig = {
  bot: { name: "TestBot", personName: "Test", publicUrl: "http://test.com", description: "Test" },
  openai: { apiKey: "test" },
  database: { url: "test", authToken: "test" },
};

describe("securityHeaders", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it("sets a default Content-Security-Policy on every response", async () => {
    const app = new Hono();
    app.use("*", securityHeaders(baseConfig));
    app.get("/test", (c) => c.text("ok"));

    const res = await app.fetch(new Request("http://localhost/test"));

    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
  });

  it("sets X-Content-Type-Options to nosniff", async () => {
    const app = new Hono();
    app.use("*", securityHeaders(baseConfig));
    app.get("/test", (c) => c.text("ok"));

    const res = await app.fetch(new Request("http://localhost/test"));

    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("uses a configured Content-Security-Policy override", async () => {
    const app = new Hono();
    const config = {
      ...baseConfig,
      server: { contentSecurityPolicy: "default-src 'none'" },
    };
    app.use("*", securityHeaders(config));
    app.get("/test", (c) => c.text("ok"));

    const res = await app.fetch(new Request("http://localhost/test"));

    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'");
  });

  it("does not set HSTS over plain HTTP outside production", async () => {
    process.env.NODE_ENV = "test";
    const app = new Hono();
    app.use("*", securityHeaders(baseConfig));
    app.get("/test", (c) => c.text("ok"));

    const res = await app.fetch(new Request("http://localhost/test"));

    expect(res.headers.get("strict-transport-security")).toBeNull();
  });

  it("sets HSTS when the request arrived over HTTPS", async () => {
    process.env.NODE_ENV = "test";
    const app = new Hono();
    app.use("*", securityHeaders(baseConfig));
    app.get("/test", (c) => c.text("ok"));

    const res = await app.fetch(new Request("https://localhost/test"));

    expect(res.headers.get("strict-transport-security")).toContain("max-age=");
  });

  it("sets HSTS when a trusted proxy signals x-forwarded-proto: https", async () => {
    process.env.NODE_ENV = "test";
    const app = new Hono();
    app.use("*", securityHeaders(baseConfig));
    app.get("/test", (c) => c.text("ok"));

    const res = await app.fetch(
      new Request("http://localhost/test", { headers: { "x-forwarded-proto": "https" } }),
    );

    expect(res.headers.get("strict-transport-security")).toContain("max-age=");
  });

  it("sets HSTS in production even over plain HTTP", async () => {
    process.env.NODE_ENV = "production";
    const app = new Hono();
    app.use("*", securityHeaders(baseConfig));
    app.get("/test", (c) => c.text("ok"));

    const res = await app.fetch(new Request("http://localhost/test"));

    expect(res.headers.get("strict-transport-security")).toContain("max-age=");
  });

  it("ignores x-forwarded-proto when trustProxy is disabled", async () => {
    process.env.NODE_ENV = "test";
    const app = new Hono();
    const config = { ...baseConfig, rateLimit: { trustProxy: false } };
    app.use("*", securityHeaders(config));
    app.get("/test", (c) => c.text("ok"));

    const res = await app.fetch(
      new Request("http://localhost/test", { headers: { "x-forwarded-proto": "https" } }),
    );

    expect(res.headers.get("strict-transport-security")).toBeNull();
  });

  it("uses a configured Strict-Transport-Security override", async () => {
    process.env.NODE_ENV = "production";
    const app = new Hono();
    const config = { ...baseConfig, server: { strictTransportSecurity: "max-age=3600" } };
    app.use("*", securityHeaders(config));
    app.get("/test", (c) => c.text("ok"));

    const res = await app.fetch(new Request("http://localhost/test"));

    expect(res.headers.get("strict-transport-security")).toBe("max-age=3600");
  });

  it("disables HSTS entirely when strictTransportSecurity is false", async () => {
    process.env.NODE_ENV = "production";
    const app = new Hono();
    const config = { ...baseConfig, server: { strictTransportSecurity: false as const } };
    app.use("*", securityHeaders(config));
    app.get("/test", (c) => c.text("ok"));

    const res = await app.fetch(new Request("http://localhost/test"));

    expect(res.headers.get("strict-transport-security")).toBeNull();
  });

  it("sets headers on a handler that returns a raw Response", async () => {
    const app = new Hono();
    app.use("*", securityHeaders(baseConfig));
    app.get("/test", () => new Response("raw"));

    const res = await app.fetch(new Request("http://localhost/test"));

    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
