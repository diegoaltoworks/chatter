/**
 * Daily limiter tests.
 *
 * Two properties matter more than the arithmetic and are asserted directly:
 * the *order* of the two increments (a key blocked at its own cap must not
 * burn shared budget), and the reserve-once semantics (every call counts,
 * including blocked ones — there is no release path to lean on).
 */

import { describe, expect, test } from "bun:test";
import {
  createDailyLimiter,
  type DailyLimitsStore,
  GLOBAL_LIMIT_KEY,
  pickDailyLimit,
  utcDayKey,
} from "./limits";

/** In-memory store that records the exact sequence of increments it received. */
function recordingStore() {
  const counts = new Map<string, number>();
  const calls: Array<{ scope: string; key: string; day: string }> = [];

  const store: DailyLimitsStore = {
    async incrementAndGet(scope, key, day) {
      calls.push({ scope, key, day });
      const id = `${scope}:${key}:${day}`;
      const next = (counts.get(id) ?? 0) + 1;
      counts.set(id, next);
      return next;
    },
  };

  return { store, calls, counts };
}

const DAY_MS = 86_400_000;

/**
 * Every limiter here runs on a frozen clock. Asserting against a day key
 * derived from the real `Date.now()` would fail on a run that crossed UTC
 * midnight between the limiter's read and the assertion's.
 */
const FIXED_NOW = Date.UTC(2026, 7, 1, 12, 0, 0);
const FIXED_DAY = "2026-08-01";
const frozen = () => FIXED_NOW;

describe("utcDayKey", () => {
  test("returns the UTC calendar day", () => {
    expect(utcDayKey(Date.UTC(2026, 7, 1, 12, 0, 0))).toBe("2026-08-01");
  });

  test("rolls over at UTC midnight, not local midnight", () => {
    expect(utcDayKey(Date.UTC(2026, 7, 1, 23, 59, 59))).toBe("2026-08-01");
    expect(utcDayKey(Date.UTC(2026, 7, 2, 0, 0, 0))).toBe("2026-08-02");
  });
});

describe("createDailyLimiter", () => {
  test("allows calls under both caps", async () => {
    const { store } = recordingStore();
    const limiter = createDailyLimiter(
      { perKeyDailyLimit: 2, globalDailyLimit: 10 },
      { store, now: frozen },
    );

    expect(await limiter.checkAndReserve("a")).toEqual({ allowed: true, reason: null });
    expect(await limiter.checkAndReserve("a")).toEqual({ allowed: true, reason: null });
  });

  test("blocks with reason per-key once the key's own cap is exceeded", async () => {
    const { store } = recordingStore();
    const limiter = createDailyLimiter(
      { perKeyDailyLimit: 1, globalDailyLimit: 10 },
      { store, now: frozen },
    );

    await limiter.checkAndReserve("a");

    expect(await limiter.checkAndReserve("a")).toEqual({ allowed: false, reason: "per-key" });
  });

  test("blocks with reason global once the shared cap is exceeded", async () => {
    const { store } = recordingStore();
    const limiter = createDailyLimiter(
      { perKeyDailyLimit: 10, globalDailyLimit: 1 },
      { store, now: frozen },
    );

    await limiter.checkAndReserve("a");

    expect(await limiter.checkAndReserve("b")).toEqual({ allowed: false, reason: "global" });
  });

  test("counts each key separately", async () => {
    const { store } = recordingStore();
    const limiter = createDailyLimiter(
      { perKeyDailyLimit: 1, globalDailyLimit: 10 },
      { store, now: frozen },
    );

    await limiter.checkAndReserve("a");

    expect(await limiter.checkAndReserve("b")).toEqual({ allowed: true, reason: null });
  });

  // The ordering guarantee: this is why the per-key increment comes first.
  test("a key blocked at its own cap never touches the global counter", async () => {
    const { store, calls, counts } = recordingStore();
    const limiter = createDailyLimiter(
      { perKeyDailyLimit: 1, globalDailyLimit: 10 },
      { store, now: frozen },
    );

    await limiter.checkAndReserve("a");
    calls.length = 0;
    const globalBefore = counts.get(`global:${GLOBAL_LIMIT_KEY}:${FIXED_DAY}`);

    await limiter.checkAndReserve("a");

    expect(calls.map((c) => c.scope)).toEqual(["key"]);
    expect(counts.get(`global:${GLOBAL_LIMIT_KEY}:${FIXED_DAY}`)).toBe(globalBefore as number);
  });

  test("increments per-key before global on the allowed path", async () => {
    const { store, calls } = recordingStore();
    const limiter = createDailyLimiter(
      { perKeyDailyLimit: 5, globalDailyLimit: 5 },
      { store, now: frozen },
    );

    await limiter.checkAndReserve("a");

    expect(calls).toEqual([
      { scope: "key", key: "a", day: FIXED_DAY },
      { scope: "global", key: GLOBAL_LIMIT_KEY, day: FIXED_DAY },
    ]);
  });

  // The accepted trade-off, pinned so it cannot regress silently: a caller
  // blocked by the global cap has already spent one of its own units.
  test("a call blocked by the global cap still consumes a per-key unit", async () => {
    const { store, counts } = recordingStore();
    const limiter = createDailyLimiter(
      { perKeyDailyLimit: 10, globalDailyLimit: 1 },
      { store, now: frozen },
    );
    const day = FIXED_DAY;

    await limiter.checkAndReserve("a");
    await limiter.checkAndReserve("b");

    expect(counts.get(`key:b:${day}`)).toBe(1);
  });

  // Reserve-once: there is no release path, so a retry costs a second unit.
  test("a retry after a blocked call burns another unit", async () => {
    const { store, counts } = recordingStore();
    const limiter = createDailyLimiter(
      { perKeyDailyLimit: 1, globalDailyLimit: 10 },
      { store, now: frozen },
    );
    const day = FIXED_DAY;

    await limiter.checkAndReserve("a");
    await limiter.checkAndReserve("a");
    await limiter.checkAndReserve("a");

    expect(counts.get(`key:a:${day}`)).toBe(3);
  });

  test("counters reset on the next UTC day", async () => {
    const { store } = recordingStore();
    let clock = Date.UTC(2026, 7, 1, 12, 0, 0);
    const limiter = createDailyLimiter(
      { perKeyDailyLimit: 1, globalDailyLimit: 1 },
      { store, now: () => clock },
    );

    await limiter.checkAndReserve("a");
    expect(await limiter.checkAndReserve("a")).toEqual({ allowed: false, reason: "per-key" });

    clock += DAY_MS;

    expect(await limiter.checkAndReserve("a")).toEqual({ allowed: true, reason: null });
  });

  test("a zero cap blocks the very first call", async () => {
    const { store } = recordingStore();
    const limiter = createDailyLimiter(
      { perKeyDailyLimit: 0, globalDailyLimit: 10 },
      { store, now: frozen },
    );

    expect(await limiter.checkAndReserve("a")).toEqual({ allowed: false, reason: "per-key" });
  });

  test("store failures propagate rather than failing open", async () => {
    const store: DailyLimitsStore = {
      async incrementAndGet() {
        throw new Error("db down");
      },
    };
    const limiter = createDailyLimiter(
      { perKeyDailyLimit: 5, globalDailyLimit: 5 },
      { store, now: frozen },
    );

    await expect(limiter.checkAndReserve("a")).rejects.toThrow("db down");
  });
});

describe("pickDailyLimit", () => {
  test("uses a configured non-negative integer", () => {
    expect(pickDailyLimit("25", 5)).toBe(25);
    expect(pickDailyLimit("0", 5)).toBe(0);
  });

  // Whitespace is the dangerous blank: Number(" ") is 0, so an untrimmed check
  // would read a stray-space config value as a cap of zero and switch the
  // feature off entirely instead of falling back.
  test("falls back when unset or blank", () => {
    expect(pickDailyLimit(undefined, 5)).toBe(5);
    expect(pickDailyLimit("", 5)).toBe(5);
    expect(pickDailyLimit(" ", 5)).toBe(5);
    expect(pickDailyLimit("\n\t", 5)).toBe(5);
  });

  test("tolerates surrounding whitespace on a real value", () => {
    expect(pickDailyLimit(" 25 ", 5)).toBe(25);
  });

  test("falls back on values that would disable the guard", () => {
    expect(pickDailyLimit("abc", 5)).toBe(5);
    expect(pickDailyLimit("-1", 5)).toBe(5);
    expect(pickDailyLimit("1.5", 5)).toBe(5);
    expect(pickDailyLimit("Infinity", 5)).toBe(5);
  });
});
