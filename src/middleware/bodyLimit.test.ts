import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { chatBodyLimit } from "./bodyLimit";

describe("chatBodyLimit", () => {
  it("passes through requests within the limit", async () => {
    const app = new Hono();
    app.use("/api/*", chatBodyLimit(1024));
    app.post("/api/test", async (c) => c.json({ ok: true }));

    const res = await app.fetch(
      new Request("http://localhost/api/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "hello" }),
      }),
    );

    expect(res.status).toBe(200);
  });

  it("rejects requests over the configured limit with a JSON 413", async () => {
    const app = new Hono();
    app.use("/api/*", chatBodyLimit(16));
    app.post("/api/test", async (c) => c.json({ ok: true }));

    const res = await app.fetch(
      new Request("http://localhost/api/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "this body is way over sixteen bytes" }),
      }),
    );

    expect(res.status).toBe(413);
    const json = await res.json();
    expect(json.error).toContain("too large");
  });

  it("defaults to a 256 KiB limit when no size is given", async () => {
    const app = new Hono();
    app.use("/api/*", chatBodyLimit());
    app.post("/api/test", async (c) => c.json({ ok: true }));

    const res = await app.fetch(
      new Request("http://localhost/api/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "x".repeat(300_000) }),
      }),
    );

    expect(res.status).toBe(413);
  });

  it("does not affect requests with no body", async () => {
    const app = new Hono();
    app.use("/api/*", chatBodyLimit(16));
    app.get("/api/test", (c) => c.json({ ok: true }));

    const res = await app.fetch(new Request("http://localhost/api/test"));

    expect(res.status).toBe(200);
  });
});
