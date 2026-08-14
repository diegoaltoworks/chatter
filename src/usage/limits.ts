/**
 * Daily spend guards — the counting half of "this feature costs money, cap it".
 *
 * Framework-free and storage-free: this module knows how to decide, never how
 * to persist. A host supplies a {@link DailyLimitsStore} (see ./tursoStore for
 * the shipped one) and instantiates one limiter per metered resource — image
 * generation, voice minutes, anything with a per-unit price — by giving each
 * its own store table. Nothing here is chat-specific.
 */

/** The two caps every metered resource is subject to. */
export interface DailyLimitsConfig {
  /** Units one key may reserve per UTC day. */
  perKeyDailyLimit: number;
  /** Units all keys together may reserve per UTC day. */
  globalDailyLimit: number;
}

/** The key the global counter is stored under — that scope has no caller key. */
export const GLOBAL_LIMIT_KEY = "global";

/** Which cap blocked the request, or null when it was allowed. */
export type DailyLimitReason = "per-key" | "global" | null;

export interface DailyLimitCheck {
  allowed: boolean;
  reason: DailyLimitReason;
}

/**
 * Structural dependency — a host implements this against its own storage.
 *
 * Must increment and read back atomically. Deployments run multiple instances,
 * so a read-then-write from this process would race with another instance's
 * and both would see room under a cap that only had space for one.
 */
export interface DailyLimitsStore {
  /** Increments the counter for (scope, key, day) and returns the count after incrementing. */
  incrementAndGet(scope: "key" | "global", key: string, day: string): Promise<number>;
}

/** The UTC calendar day counters roll over on, e.g. "2026-08-01". */
export function utcDayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export interface DailyLimiterDeps {
  store: DailyLimitsStore;
  /** Clock, injectable so day-rollover tests don't depend on real time. */
  now?: () => number;
}

export interface DailyLimiter {
  /**
   * Reserves one unit for `key`, subject to both daily caps.
   *
   * Call this exactly once per logical request: the increment is permanent and
   * unconditional (there is no release path), so a duplicate call — or a retry
   * after a transient failure — permanently burns a second unit of quota for
   * one request never delivered. Blocked calls still count: a call that trips
   * the per-key cap still consumes one of that key's daily units, and (by
   * design — see below) a call that trips the global cap after passing the
   * per-key check also consumes one of that key's units, for nothing.
   *
   * The per-key counter increments before the global one, so a key blocked at
   * its own cap never touches the shared global budget. The mirror case is
   * accepted, not fixed: once the global cap is exhausted for the day, every
   * further caller still burns one of their own per-key units on the way to
   * being told no. This favours guarding against the more common cost risk
   * (one key hammering the endpoint) over the rarer one (the global cap
   * saturating and clipping everyone's personal quota).
   *
   * Reserve before spending, not after: the ordering is what makes the cap a
   * cap. Callers with a cache should check it first, so a cache hit costs
   * neither money nor quota.
   */
  checkAndReserve(key: string): Promise<DailyLimitCheck>;
}

export function createDailyLimiter(
  config: DailyLimitsConfig,
  deps: DailyLimiterDeps,
): DailyLimiter {
  const now = deps.now ?? Date.now;

  return {
    async checkAndReserve(key: string): Promise<DailyLimitCheck> {
      const day = utcDayKey(now());

      const perKeyCount = await deps.store.incrementAndGet("key", key, day);
      if (perKeyCount > config.perKeyDailyLimit) {
        return { allowed: false, reason: "per-key" };
      }

      const globalCount = await deps.store.incrementAndGet("global", GLOBAL_LIMIT_KEY, day);
      if (globalCount > config.globalDailyLimit) {
        return { allowed: false, reason: "global" };
      }

      return { allowed: true, reason: null };
    },
  };
}

/**
 * Reads a cap out of loosely-typed configuration (an env var, a JSON field).
 *
 * A configured non-negative integer wins over the default; anything else —
 * unset, blank, negative, fractional, unparseable — falls back. A malformed
 * cap must not silently become `NaN`, which compares false against every
 * count and would disable the guard entirely.
 *
 * Blank is trimmed before parsing rather than compared raw: `Number(" ")` is
 * `0`, so a config value that is whitespace would otherwise be read as a cap
 * of zero and switch the feature off entirely instead of falling back.
 *
 * This is the supported way to build a {@link DailyLimitsConfig}. The limiter
 * itself does not validate its caps, so a `NaN` reaching it from somewhere
 * else fails open.
 */
export function pickDailyLimit(value: string | undefined, fallback: number): number {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed === "") return fallback;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}
