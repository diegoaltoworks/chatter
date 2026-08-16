import { describe, expect, test } from "bun:test";
import { parseArgs } from "./wa-pair-args";

describe("parseArgs", () => {
  test("no args: default session, QR mode, no reset", () => {
    expect(parseArgs([])).toEqual({
      ok: true,
      help: false,
      sessionId: "default",
      phoneNumber: undefined,
      reset: false,
    });
  });

  test("a positional argument sets sessionId", () => {
    const result = parseArgs(["work"]);
    expect(result).toEqual({
      ok: true,
      help: false,
      sessionId: "work",
      phoneNumber: undefined,
      reset: false,
    });
  });

  test("--code digits become phoneNumber, non-digits stripped", () => {
    const result = parseArgs(["--code", "+44 7700 900123"]);
    expect(result).toEqual({
      ok: true,
      help: false,
      sessionId: "default",
      phoneNumber: "447700900123",
      reset: false,
    });
  });

  test("--reset sets the flag", () => {
    const result = parseArgs(["--reset"]);
    expect(result).toEqual({
      ok: true,
      help: false,
      sessionId: "default",
      phoneNumber: undefined,
      reset: true,
    });
  });

  test("sessionId, --code and --reset combine", () => {
    const result = parseArgs(["work", "--code", "447700900123", "--reset"]);
    expect(result).toEqual({
      ok: true,
      help: false,
      sessionId: "work",
      phoneNumber: "447700900123",
      reset: true,
    });
  });

  test("--help short-circuits before other flags are read", () => {
    expect(parseArgs(["--code", "123", "--help"])).toEqual({ ok: true, help: true });
    expect(parseArgs(["-h"])).toEqual({ ok: true, help: true });
  });

  test("--code with no value fails", () => {
    const result = parseArgs(["--code"]);
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain("--code");
  });

  test("--code swallowing the next flag as its value fails instead of silently clearing that flag", () => {
    const result = parseArgs(["--code", "--reset"]);
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain("--code");
  });

  test("--code that strips to no digits fails instead of silently falling back to QR mode", () => {
    const result = parseArgs(["--code", "abc"]);
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain("--code");
  });

  test("an unrecognized flag fails closed", () => {
    const result = parseArgs(["--codee", "123"]);
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain("--codee");
  });

  test("a second positional argument fails closed", () => {
    const result = parseArgs(["work", "extra"]);
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain("extra");
  });
});
