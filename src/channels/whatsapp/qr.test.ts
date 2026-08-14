import { describe, expect, test } from "bun:test";
import { type QrTerminalModule, resolveQrGenerate } from "./qr";

let lastCall: { thisError: string | undefined; args: unknown[] } | undefined;

/** qrcode-terminal's real `generate` reads `this.error` — exercise that too. */
function generateReadingThis(this: { error?: string } | undefined, ...args: unknown[]): void {
  lastCall = { thisError: this?.error, args };
}

describe("resolveQrGenerate", () => {
  test("resolves and binds generate nested under .default (Node's CJS interop)", () => {
    const target = { error: "via-default", generate: generateReadingThis };
    const generate = resolveQrGenerate({ default: target } as unknown as QrTerminalModule);
    expect(generate).toBeDefined();
    generate?.("qr", { small: true });
    expect(lastCall).toEqual({ thisError: "via-default", args: ["qr", { small: true }] });
  });

  test("resolves and binds a named .generate export (Bun's CJS interop)", () => {
    const mod = { error: "via-named", generate: generateReadingThis };
    const generate = resolveQrGenerate(mod as unknown as QrTerminalModule);
    expect(generate).toBeDefined();
    generate?.("qr", { small: true });
    expect(lastCall).toEqual({ thisError: "via-named", args: ["qr", { small: true }] });
  });

  test("prefers .default.generate when both shapes are present", () => {
    const mod = {
      default: { error: "default-wins", generate: generateReadingThis },
      error: "named-loses",
      generate: generateReadingThis,
    };
    const generate = resolveQrGenerate(mod as unknown as QrTerminalModule);
    generate?.("qr");
    expect(lastCall?.thisError).toBe("default-wins");
  });

  test("returns undefined for a missing or empty module", () => {
    expect(resolveQrGenerate(undefined)).toBeUndefined();
    expect(resolveQrGenerate({})).toBeUndefined();
    expect(resolveQrGenerate({ default: {} })).toBeUndefined();
  });
});
