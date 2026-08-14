import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { signCloudinaryParams } from "./cloudinarySignature";

describe("signCloudinaryParams", () => {
  test("sorts keys before signing", () => {
    const a = signCloudinaryParams({ b: "2", a: "1" }, "secret");
    const b = signCloudinaryParams({ a: "1", b: "2" }, "secret");
    expect(a).toBe(b);
  });

  test("matches the documented sha1(sorted key=value&...+secret) scheme", () => {
    const expected = createHash("sha1").update("a=1&b=2secret").digest("hex");
    expect(signCloudinaryParams({ b: "2", a: "1" }, "secret")).toBe(expected);
  });

  test("differs when the secret changes", () => {
    const a = signCloudinaryParams({ a: "1" }, "secret1");
    const b = signCloudinaryParams({ a: "1" }, "secret2");
    expect(a).not.toBe(b);
  });
});
