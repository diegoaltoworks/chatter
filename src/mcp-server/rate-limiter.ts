/**
 * Rate Limiting for MCP Tools
 * Simple in-memory sliding window implementation
 */

/** Default sliding-window size: 1 minute. */
export const DEFAULT_WINDOW_MS = 60_000;

/**
 * Rate limiter using sliding window algorithm
 */
export class RateLimiter {
  private requestMap: Map<string, number[]>;
  private readonly limit: number;
  private readonly windowMs: number;

  /**
   * Create a new rate limiter
   *
   * @param limit - Maximum requests allowed in the time window
   * @param windowMs - Time window in milliseconds (default: `DEFAULT_WINDOW_MS`)
   */
  constructor(limit: number, windowMs = DEFAULT_WINDOW_MS) {
    this.requestMap = new Map();
    this.limit = limit;
    this.windowMs = windowMs;
  }

  /**
   * Check if a request should be allowed
   *
   * @param key - Unique identifier for the rate limit (e.g., tool name)
   * @returns true if request is allowed, false if rate limit exceeded
   */
  check(key: string): boolean {
    const now = Date.now();
    const windowStart = now - this.windowMs;

    const timestamps = this.requestMap.get(key) || [];
    const recentTimestamps = timestamps.filter((ts) => ts > windowStart);

    if (recentTimestamps.length >= this.limit) {
      return false;
    }

    recentTimestamps.push(now);
    this.requestMap.set(key, recentTimestamps);

    return true;
  }

  /**
   * Get current request count for a key
   *
   * @param key - Unique identifier
   * @returns Current number of requests in the window
   */
  getCount(key: string): number {
    const now = Date.now();
    const windowStart = now - this.windowMs;
    const timestamps = this.requestMap.get(key) || [];
    return timestamps.filter((ts) => ts > windowStart).length;
  }

  /**
   * Reset rate limit for a specific key
   *
   * @param key - Unique identifier to reset
   */
  reset(key: string): void {
    this.requestMap.delete(key);
  }

  /**
   * Reset all rate limits
   */
  resetAll(): void {
    this.requestMap.clear();
  }

  /**
   * Get time until rate limit resets (in ms)
   *
   * @param key - Unique identifier
   * @returns Milliseconds until the oldest request falls out of the window
   */
  getTimeUntilReset(key: string): number {
    const timestamps = this.requestMap.get(key) || [];
    if (timestamps.length === 0) return 0;

    const now = Date.now();
    const oldestTimestamp = Math.min(...timestamps);
    const timeUntilReset = this.windowMs - (now - oldestTimestamp);

    return Math.max(0, timeUntilReset);
  }
}

/**
 * Create a rate limiter if limit is specified.
 *
 * Named `createMcpRateLimiter` (not `createRateLimiter`) so it doesn't
 * collide with `middleware/ratelimit.ts`'s `createRateLimiter` - an
 * unrelated HTTP rate limiter with a different signature and return type,
 * easy to import the wrong one of by name alone.
 *
 * @param limit - Maximum requests per window, or undefined for no limit
 * @param windowMs - Time window in milliseconds
 * @returns RateLimiter instance or null if no limit specified
 */
export function createMcpRateLimiter(
  limit: number | undefined,
  windowMs = DEFAULT_WINDOW_MS,
): RateLimiter | null {
  return limit ? new RateLimiter(limit, windowMs) : null;
}
