import { describe, expect, test } from "bun:test";
import { dueDrops, isDue, isWithinGrace, staleDrops } from "./dueDrops";
import type { ScheduleEntry } from "./types";

function entry(overrides: Partial<ScheduleEntry> = {}): ScheduleEntry {
  return { id: "job-1", fireAt: 1_000, channel: "whatsapp", chatId: "chat-1", ...overrides };
}

describe("isDue", () => {
  test("future entries are not due", () => {
    expect(isDue(entry({ fireAt: 2_000 }), 1_000)).toBe(false);
  });

  test("past or now entries are due", () => {
    expect(isDue(entry({ fireAt: 1_000 }), 1_000)).toBe(true);
    expect(isDue(entry({ fireAt: 500 }), 1_000)).toBe(true);
  });
});

describe("isWithinGrace", () => {
  test("true right at the fire time", () => {
    expect(isWithinGrace(entry({ fireAt: 1_000 }), 1_000, 5_000)).toBe(true);
  });

  test("true up to the grace boundary", () => {
    expect(isWithinGrace(entry({ fireAt: 1_000 }), 6_000, 5_000)).toBe(true);
  });

  test("false once past the grace window", () => {
    expect(isWithinGrace(entry({ fireAt: 1_000 }), 6_001, 5_000)).toBe(false);
  });
});

describe("dueDrops", () => {
  test("excludes future entries", () => {
    expect(dueDrops([entry({ fireAt: 2_000 })], 1_000, 5_000)).toEqual([]);
  });

  test("excludes entries past grace", () => {
    expect(dueDrops([entry({ fireAt: 0 })], 10_000, 5_000)).toEqual([]);
  });

  test("includes due entries within grace", () => {
    const due = entry({ fireAt: 1_000 });
    expect(dueDrops([due], 1_500, 5_000)).toEqual([due]);
  });
});

describe("staleDrops", () => {
  test("reports due entries whose grace has passed", () => {
    const stale = entry({ fireAt: 0 });
    expect(staleDrops([stale], 10_000, 5_000)).toEqual([stale]);
  });

  test("excludes entries still within grace", () => {
    expect(staleDrops([entry({ fireAt: 1_000 })], 1_500, 5_000)).toEqual([]);
  });

  test("excludes future entries", () => {
    expect(staleDrops([entry({ fireAt: 2_000 })], 1_000, 5_000)).toEqual([]);
  });
});
