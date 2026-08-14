import { describe, expect, test } from "bun:test";
import { timeContext } from "./timeContext";

describe("timeContext", () => {
  test("formats one line per zone with a fixed clock", () => {
    const at = Date.UTC(2026, 7, 14, 12, 0); // 2026-08-14T12:00Z
    const result = timeContext(["UTC"], at);
    expect(result).toContain("Friday 14 August 2026");
    expect(result).toContain("(UTC)");
  });

  test("includes every zone, in order", () => {
    const at = Date.UTC(2026, 7, 14, 12, 0);
    const result = timeContext(["UTC", "Europe/London"], at);
    const utcIndex = result.indexOf("(UTC)");
    const londonIndex = result.indexOf("(Europe/London)");
    expect(utcIndex).toBeGreaterThan(-1);
    expect(londonIndex).toBeGreaterThan(utcIndex);
  });

  test("empty zones list returns an empty string", () => {
    expect(timeContext([])).toBe("");
  });

  test("an invalid IANA zone is skipped, not thrown", () => {
    const at = Date.UTC(2026, 7, 14, 12, 0);
    const result = timeContext(["not-a-real-zone", "UTC"], at);
    expect(result).toContain("(UTC)");
    expect(result).not.toContain("not-a-real-zone");
  });

  test("all-invalid zones degrade to an empty string", () => {
    expect(timeContext(["not-a-real-zone"], Date.UTC(2026, 7, 14, 12, 0))).toBe("");
  });
});
