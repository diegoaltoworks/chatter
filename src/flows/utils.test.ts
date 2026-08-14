import { describe, expect, test } from "bun:test";
import { shouldExitFlow } from "./utils";

describe("shouldExitFlow", () => {
  test("matches the default cancellation keywords case-insensitively", () => {
    expect(shouldExitFlow("Cancel please")).toBe(true);
    expect(shouldExitFlow("never mind")).toBe(true);
    expect(shouldExitFlow("nevermind")).toBe(true);
    expect(shouldExitFlow("forget it")).toBe(true);
    expect(shouldExitFlow("STOP")).toBe(true);
    expect(shouldExitFlow("continue please")).toBe(false);
  });

  test("matches on whole words/phrases only, not as a substring inside a longer word", () => {
    expect(shouldExitFlow("it's a nonstop flight")).toBe(false);
    expect(shouldExitFlow("stopping by later")).toBe(false);
    expect(shouldExitFlow("please stop")).toBe(true);
  });

  test("honours a custom keyword list", () => {
    expect(shouldExitFlow("actually exit now", ["exit"])).toBe(true);
    expect(shouldExitFlow("cancel", ["exit"])).toBe(false);
  });
});
