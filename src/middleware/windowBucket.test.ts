import { describe, expect, it } from "bun:test";
import { createWindowBucketLimiter } from "./windowBucket";

describe("createWindowBucketLimiter", () => {
  it("allows hits within the limit and blocks beyond it", () => {
    const now = 0;
    const limiter = createWindowBucketLimiter(1000, () => now);

    expect(limiter.hit("a", 3)).toBe(true);
    expect(limiter.hit("a", 3)).toBe(true);
    expect(limiter.hit("a", 3)).toBe(true);
    expect(limiter.hit("a", 3)).toBe(false);
  });

  it("tracks keys independently", () => {
    const now = 0;
    const limiter = createWindowBucketLimiter(1000, () => now);

    limiter.hit("a", 1);
    expect(limiter.hit("a", 1)).toBe(false);
    expect(limiter.hit("b", 1)).toBe(true);
  });

  it("resets a key's own count once its window elapses", () => {
    let now = 0;
    const limiter = createWindowBucketLimiter(1000, () => now);

    limiter.hit("a", 1);
    expect(limiter.hit("a", 1)).toBe(false);

    now = 1000;
    expect(limiter.hit("a", 1)).toBe(true);
  });

  it("evicts keys that have gone stale, bounding map size instead of growing forever", () => {
    let now = 0;
    const limiter = createWindowBucketLimiter(1000, () => now);

    // A flood of distinct keys — e.g. an attacker rotating a fake IP per
    // request — must not accumulate in the map past their own window.
    for (let i = 0; i < 500; i++) {
      limiter.hit(`spoofed-${i}`, 100);
    }
    expect(limiter.size()).toBe(500);

    // Advance past the window and beyond the sweep threshold; the next hit
    // (any key) triggers a sweep that drops everything now stale.
    now = 2500;
    limiter.hit("fresh", 100);

    expect(limiter.size()).toBe(1);
  });

  it("does not reset a key's own count when a sweep runs for other keys' traffic", () => {
    let now = 1500;
    const limiter = createWindowBucketLimiter(1000, () => now);

    // First write ever, so the initial sweep threshold starts here.
    limiter.hit("bystander", 1); // count=1, allowed

    now = 2000;
    limiter.hit("other", 1); // no sweep yet (500ms since last write)

    now = 2600;
    // This write is old enough to trigger a sweep (1100ms since the first
    // write). "bystander" is only 1100ms old too, so it's swept — but
    // "other" is just 600ms old and must survive with its count intact.
    limiter.hit("trigger", 1);
    expect(limiter.hit("other", 1)).toBe(false); // 2nd hit on an already-1 bucket
  });
});
