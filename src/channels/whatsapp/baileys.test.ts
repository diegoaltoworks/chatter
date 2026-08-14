import { describe, expect, test } from "bun:test";
import { loadBaileys, silentLogger, wrapMissingBaileysError } from "./baileys";

describe("wrapMissingBaileysError", () => {
  test("names the package and an install command, and preserves the original cause", () => {
    const cause = new Error("Cannot find package '@whiskeysockets/baileys'");

    const wrapped = wrapMissingBaileysError(cause);

    expect(wrapped.message).toContain("@whiskeysockets/baileys");
    expect(wrapped.message).toContain("bun add @whiskeysockets/baileys");
    expect(wrapped.cause).toBe(cause);
  });
});

describe("loadBaileys", () => {
  // The optional peer dependency is installed in this repo's devDependencies
  // (for types and tests), so this proves the happy path resolves; the
  // missing-package path is covered by wrapMissingBaileysError above without
  // needing to simulate an actually-uninstalled package.
  test("resolves the real module when it is installed", async () => {
    const baileys = await loadBaileys();

    expect(typeof baileys.makeWASocket).toBe("function");
  });
});

describe("silentLogger", () => {
  test("every level is a callable no-op, including a self-returning child()", () => {
    const logger = silentLogger() as Record<string, unknown>;

    for (const level of ["trace", "debug", "info", "warn", "error", "fatal"]) {
      expect(() => (logger[level] as () => void)()).not.toThrow();
    }
    expect(logger.child).toBeInstanceOf(Function);
    expect((logger.child as () => unknown)()).toBe(logger);
  });
});
