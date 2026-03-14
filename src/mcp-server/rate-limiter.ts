/**
 * Rate Limiting for MCP Tools
 * Simple in-memory sliding window implementation
 */

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
   * @param windowMs - Time window in milliseconds (default: 60000 = 1 minute)
   */
  constructor(limit: number, windowMs = 60000) {
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

    // Get or initialize request timestamps for this key
    const timestamps = this.requestMap.get(key) || [];

    // Remove old timestamps outside the window
    const recentTimestamps = timestamps.filter((ts) => ts > windowStart);

    // Check if rate limit exceeded
    if (recentTimestamps.length >= this.limit) {
      return false;
    }

    // Add current timestamp and update map
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
 * Create a rate limiter if limit is specified
 *
 * @param limit - Maximum requests per window, or undefined for no limit
 * @param windowMs - Time window in milliseconds
 * @returns RateLimiter instance or null if no limit specified
 */
export function createRateLimiter(limit: number | undefined, windowMs = 60000): RateLimiter | null {
  return limit ? new RateLimiter(limit, windowMs) : null;
}
