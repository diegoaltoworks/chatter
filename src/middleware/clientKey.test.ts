import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { clientRateLimitKey } from "./clientKey";

async function keyFor(headers: Record<string, string>, trustProxy: boolean) {
  let captured = "";
  const app = new Hono();
  app.get("/", (c) => {
    captured = clientRateLimitKey(c, trustProxy);
    return c.text("ok");
  });
  await app.fetch(new Request("http://localhost/", { headers }));
  return captured;
}

describe("clientRateLimitKey", () => {
  it("keys by the first X-Forwarded-For entry when trustProxy is true", async () => {
    const key = await keyFor({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" }, true);
    expect(key).toBe("1.2.3.4");
  });

  it("falls back to unknown-ip when trustProxy is true but XFF is missing", async () => {
    const key = await keyFor({}, true);
    expect(key).toBe("unknown-ip");
  });

  it("ignores a caller-supplied XFF and collapses to one shared key when trustProxy is false", async () => {
    const keyA = await keyFor({ "x-forwarded-for": "1.2.3.4" }, false);
    const keyB = await keyFor({ "x-forwarded-for": "9.9.9.9" }, false);
    expect(keyA).toBe(keyB);
    expect(keyA).toBe("shared");
  });
});
