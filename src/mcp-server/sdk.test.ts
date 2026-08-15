import { describe, expect, test } from "bun:test";
import { loadMcpSdk, loadZod, wrapMissingMcpPeerError } from "./sdk";

describe("wrapMissingMcpPeerError", () => {
  test("names the package and an install command, and preserves the original cause", () => {
    const cause = new Error("Cannot find package 'zod'");

    const wrapped = wrapMissingMcpPeerError("zod", cause);

    expect(wrapped.message).toContain("zod");
    expect(wrapped.message).toContain("bun add zod");
    expect(wrapped.cause).toBe(cause);
  });
});

describe("loadMcpSdk", () => {
  // The optional peer dependency is installed in this repo's devDependencies
  // (for types and tests), so this proves the happy path resolves; the
  // missing-package path is covered by wrapMissingMcpPeerError above without
  // needing to simulate an actually-uninstalled package.
  test("resolves the real McpServer constructor when the SDK is installed", async () => {
    const McpServer = await loadMcpSdk();

    expect(typeof McpServer).toBe("function");
  });
});

describe("loadZod", () => {
  test("resolves the real zod runtime when it is installed", async () => {
    const z = await loadZod();

    expect(typeof z.string).toBe("function");
  });
});
