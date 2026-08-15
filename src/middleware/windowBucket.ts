/**
 * Fixed-window request counter with self-eviction. Every fixed-window
 * limiter in this codebase used to key a plain `Map` by caller-supplied
 * identity (IP, session id) and only ever reset an entry when that same key
 * came back — a key that never returns (e.g. an attacker rotating a fake
 * `X-Forwarded-For` per request) stayed in the map forever, an unbounded
 * memory sink. This sweeps expired entries on write instead, so map size
 * stays bounded by the number of distinct keys active within roughly the
 * last two windows — a sweep only runs once per window and only on a
 * write, so an entry can sit stale for up to one extra window before the
 * next sweep clears it.
 */
export function createWindowBucketLimiter(windowMs: number, now: () => number = Date.now) {
  const buckets = new Map<string, { count: number; windowStart: number }>();
  let lastSweep = now();

  function sweep(current: number) {
    if (current - lastSweep < windowMs) return;
    lastSweep = current;
    for (const [key, bucket] of buckets) {
      if (current - bucket.windowStart >= windowMs) buckets.delete(key);
    }
  }

  return {
    /** Records one hit for `key` and reports whether it's still within `limit`. */
    hit(key: string, limit: number): boolean {
      const current = now();
      sweep(current);

      const bucket = buckets.get(key);
      if (!bucket || current - bucket.windowStart >= windowMs) {
        buckets.set(key, { count: 1, windowStart: current });
        return 1 <= limit;
      }
      bucket.count += 1;
      return bucket.count <= limit;
    },
    /** Current map size — for tests asserting eviction actually happened. */
    size(): number {
      return buckets.size;
    },
  };
}
