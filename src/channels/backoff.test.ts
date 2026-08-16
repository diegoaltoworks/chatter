import { describe, expect, test } from "bun:test";
import { exponentialBackoffMs } from "./backoff";

describe("exponentialBackoffMs", () => {
  test("doubles per step from the base", () => {
    expect(exponentialBackoffMs(1_000, 60_000, 0)).toBe(1_000);
    expect(exponentialBackoffMs(1_000, 60_000, 1)).toBe(2_000);
    expect(exponentialBackoffMs(1_000, 60_000, 2)).toBe(4_000);
    expect(exponentialBackoffMs(1_000, 60_000, 3)).toBe(8_000);
  });

  test("caps at max once the doubling would exceed it", () => {
    expect(exponentialBackoffMs(1_000, 60_000, 10)).toBe(60_000);
    expect(exponentialBackoffMs(1_000, 60_000, 30)).toBe(60_000);
  });

  test("a negative n is clamped to 0, never producing a delay below base", () => {
    expect(exponentialBackoffMs(2_000, 8_000, -5)).toBe(2_000);
  });
});
