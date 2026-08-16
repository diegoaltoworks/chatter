import { describe, expect, test } from "bun:test";
import { parseArgs } from "./create-apikey-args";

describe("parseArgs", () => {
  test("no args: ok, no options", () => {
    expect(parseArgs([])).toEqual({ ok: true, help: false });
  });

  test("--name and --expires-in are captured", () => {
    expect(parseArgs(["--name", "my-key", "--expires-in", "1h"])).toEqual({
      ok: true,
      help: false,
      name: "my-key",
      expiresIn: "1h",
    });
  });

  test("--help short-circuits before other flags are read", () => {
    expect(parseArgs(["--name", "x", "--help"])).toEqual({ ok: true, help: true });
    expect(parseArgs(["-h"])).toEqual({ ok: true, help: true });
  });

  test("a flag missing its value fails instead of swallowing the next flag", () => {
    const result = parseArgs(["--name"]);
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain("--name");
  });

  test("--expires-in missing its value fails the same way", () => {
    const result = parseArgs(["--expires-in"]);
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain("--expires-in");
  });

  test("a value that looks like a flag is rejected, not swallowed as the value", () => {
    const result = parseArgs(["--name", "--expires-in", "1y"]);
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain("--name");
  });

  test("an unrecognized flag fails closed rather than being silently ignored", () => {
    const result = parseArgs(["--nam", "typo"]);
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain("--nam");
  });

  test("a bare positional argument is rejected (no subcommand exists)", () => {
    const result = parseArgs(["create-apikey", "--name", "x"]);
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain("create-apikey");
  });
});
