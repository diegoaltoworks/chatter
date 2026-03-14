import { beforeEach, describe, expect, it } from "bun:test";
import { RateLimiter, createRateLimiter } from "./rate-limiter";

describe("RateLimiter", () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter(3, 1000); // 3 requests per 1 second
  });

  describe("check", () => {
    it("should allow requests under the limit", () => {
      expect(limiter.check("tool1")).toBe(true);
      expect(limiter.check("tool1")).toBe(true);
      expect(limiter.check("tool1")).toBe(true);
    });

    it("should block requests over the limit", () => {
      limiter.check("tool1");
      limiter.check("tool1");
      limiter.check("tool1");

      expect(limiter.check("tool1")).toBe(false);
    });

    it("should track different keys separately", () => {
      limiter.check("tool1");
      limiter.check("tool1");
      limiter.check("tool1");

      expect(limiter.check("tool1")).toBe(false);
      expect(limiter.check("tool2")).toBe(true); // Different key
    });

    it("should allow requests after window expires", async () => {
      limiter.check("tool1");
      limiter.check("tool1");
      limiter.check("tool1");

      expect(limiter.check("tool1")).toBe(false);

      // Wait for window to expire
      await new Promise((resolve) => setTimeout(resolve, 1100));

      expect(limiter.check("tool1")).toBe(true);
    });

    it("should use sliding window (not fixed window)", async () => {
      const limiter = new RateLimiter(2, 500);

      limiter.check("tool1");
      await new Promise((resolve) => setTimeout(resolve, 300));
      limiter.check("tool1");

      // Still within window, should be blocked
      expect(limiter.check("tool1")).toBe(false);

      // Wait for first request to expire
      await new Promise((resolve) => setTimeout(resolve, 300));

      // First request should be out of window now
      expect(limiter.check("tool1")).toBe(true);
    });
  });

  describe("getCount", () => {
    it("should return current request count", () => {
      expect(limiter.getCount("tool1")).toBe(0);

      limiter.check("tool1");
      expect(limiter.getCount("tool1")).toBe(1);

      limiter.check("tool1");
      expect(limiter.getCount("tool1")).toBe(2);
    });

    it("should not count expired requests", async () => {
      limiter.check("tool1");
      limiter.check("tool1");
      expect(limiter.getCount("tool1")).toBe(2);

      await new Promise((resolve) => setTimeout(resolve, 1100));

      expect(limiter.getCount("tool1")).toBe(0);
    });

    it("should return 0 for non-existent keys", () => {
      expect(limiter.getCount("nonexistent")).toBe(0);
    });
  });

  describe("reset", () => {
    it("should reset rate limit for specific key", () => {
      limiter.check("tool1");
      limiter.check("tool1");
      expect(limiter.getCount("tool1")).toBe(2);

      limiter.reset("tool1");
      expect(limiter.getCount("tool1")).toBe(0);
    });

    it("should not affect other keys", () => {
      limiter.check("tool1");
      limiter.check("tool2");

      limiter.reset("tool1");

      expect(limiter.getCount("tool1")).toBe(0);
      expect(limiter.getCount("tool2")).toBe(1);
    });

    it("should allow requests after reset", () => {
      limiter.check("tool1");
      limiter.check("tool1");
      limiter.check("tool1");

      expect(limiter.check("tool1")).toBe(false);

      limiter.reset("tool1");
      expect(limiter.check("tool1")).toBe(true);
    });
  });

  describe("resetAll", () => {
    it("should reset all rate limits", () => {
      limiter.check("tool1");
      limiter.check("tool2");
      limiter.check("tool3");

      limiter.resetAll();

      expect(limiter.getCount("tool1")).toBe(0);
      expect(limiter.getCount("tool2")).toBe(0);
      expect(limiter.getCount("tool3")).toBe(0);
    });
  });

  describe("getTimeUntilReset", () => {
    it("should return 0 for non-existent keys", () => {
      expect(limiter.getTimeUntilReset("nonexistent")).toBe(0);
    });

    it("should return time until oldest request expires", () => {
      limiter.check("tool1");
      const time = limiter.getTimeUntilReset("tool1");

      expect(time).toBeGreaterThan(0);
      expect(time).toBeLessThanOrEqual(1000);
    });

    it("should decrease over time", async () => {
      limiter.check("tool1");
      const initialTime = limiter.getTimeUntilReset("tool1");

      await new Promise((resolve) => setTimeout(resolve, 100));

      const laterTime = limiter.getTimeUntilReset("tool1");
      expect(laterTime).toBeLessThan(initialTime);
    });

    it("should return 0 after window expires", async () => {
      limiter.check("tool1");

      await new Promise((resolve) => setTimeout(resolve, 1100));

      expect(limiter.getTimeUntilReset("tool1")).toBe(0);
    });
  });

  describe("Integration scenarios", () => {
    it("should handle burst traffic correctly", () => {
      const limiter = new RateLimiter(5, 1000);

      // Burst of 5 requests
      for (let i = 0; i < 5; i++) {
        expect(limiter.check("api")).toBe(true);
      }

      // 6th request should be blocked
      expect(limiter.check("api")).toBe(false);
    });

    it("should handle mixed keys under load", () => {
      const limiter = new RateLimiter(2, 1000);

      expect(limiter.check("tool1")).toBe(true);
      expect(limiter.check("tool2")).toBe(true);
      expect(limiter.check("tool1")).toBe(true);
      expect(limiter.check("tool2")).toBe(true);

      // Both should be at limit
      expect(limiter.check("tool1")).toBe(false);
      expect(limiter.check("tool2")).toBe(false);
    });

    it("should maintain accuracy over multiple windows", async () => {
      const limiter = new RateLimiter(1, 200);

      expect(limiter.check("tool1")).toBe(true);
      expect(limiter.check("tool1")).toBe(false);

      await new Promise((resolve) => setTimeout(resolve, 250));

      expect(limiter.check("tool1")).toBe(true);
      expect(limiter.check("tool1")).toBe(false);
    });
  });
});

describe("createRateLimiter", () => {
  it("should create rate limiter when limit is specified", () => {
    const limiter = createRateLimiter(10);
    expect(limiter).not.toBeNull();
    expect(limiter).toBeInstanceOf(RateLimiter);
  });

  it("should return null when limit is undefined", () => {
    const limiter = createRateLimiter(undefined);
    expect(limiter).toBeNull();
  });

  it("should use custom window size", () => {
    const limiter = createRateLimiter(5, 2000);
    expect(limiter).not.toBeNull();
  });

  it("should create functional limiter", () => {
    const limiter = createRateLimiter(2);
    expect(limiter).not.toBeNull();

    if (limiter) {
      expect(limiter.check("test")).toBe(true);
      expect(limiter.check("test")).toBe(true);
      expect(limiter.check("test")).toBe(false);
    }
  });
});
