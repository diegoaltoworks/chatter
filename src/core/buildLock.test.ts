/**
 * Build-lock tests
 *
 * The pure predicate is tested directly; the libsql-backed lock is tested
 * against a real in-memory client, because the property under test ("two
 * racing holders can never both win") lives in the SQL, which a mock cannot
 * prove.
 */

import { describe, expect, test } from "bun:test";
import { createClient } from "@libsql/client";
import {
  BUILD_LOCK_KEY,
  BUILD_LOCK_STALE_MS,
  canAcquireBuildLock,
  createTursoBuildLock,
} from "./buildLock";

describe("canAcquireBuildLock", () => {
  test("grants an unheld lock", () => {
    expect(canAcquireBuildLock(null, "a", 1_000)).toBe(true);
  });

  test("lets the current holder renew its own lock", () => {
    expect(canAcquireBuildLock({ holderId: "a", heartbeatAt: 1_000 }, "a", 1_001)).toBe(true);
  });

  test("refuses another instance while the holder is still heartbeating", () => {
    expect(canAcquireBuildLock({ holderId: "a", heartbeatAt: 1_000 }, "b", 1_001)).toBe(false);
  });

  test("grants another instance once the holder has gone stale", () => {
    const now = 1_000 + BUILD_LOCK_STALE_MS;
    expect(canAcquireBuildLock({ holderId: "a", heartbeatAt: 1_000 }, "b", now)).toBe(true);
  });
});

describe("createTursoBuildLock", () => {
  function freshLock() {
    return createTursoBuildLock(createClient({ url: "file::memory:", authToken: "" }));
  }

  test("only one of two instances racing the same key wins", async () => {
    const lock = freshLock();

    const results = await Promise.all([
      lock.tryAcquire(BUILD_LOCK_KEY, "a", 1_000, BUILD_LOCK_STALE_MS),
      lock.tryAcquire(BUILD_LOCK_KEY, "b", 1_000, BUILD_LOCK_STALE_MS),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  test("the holder can renew, and a second instance stays locked out until the lock goes stale", async () => {
    const lock = freshLock();

    expect(await lock.tryAcquire(BUILD_LOCK_KEY, "a", 1_000, BUILD_LOCK_STALE_MS)).toBe(true);
    expect(await lock.tryAcquire(BUILD_LOCK_KEY, "a", 2_000, BUILD_LOCK_STALE_MS)).toBe(true);
    expect(await lock.tryAcquire(BUILD_LOCK_KEY, "b", 2_001, BUILD_LOCK_STALE_MS)).toBe(false);

    // A holder that dies without releasing must not wedge every later boot:
    // the heartbeat it left behind ages out and the next instance takes over.
    const afterStale = 2_000 + BUILD_LOCK_STALE_MS;
    expect(await lock.tryAcquire(BUILD_LOCK_KEY, "b", afterStale, BUILD_LOCK_STALE_MS)).toBe(true);
  });

  test("release frees the lock for the next instance", async () => {
    const lock = freshLock();

    await lock.tryAcquire(BUILD_LOCK_KEY, "a", 1_000, BUILD_LOCK_STALE_MS);
    await lock.release(BUILD_LOCK_KEY, "a");

    expect(await lock.tryAcquire(BUILD_LOCK_KEY, "b", 1_001, BUILD_LOCK_STALE_MS)).toBe(true);
  });

  test("a late release from a superseded holder does not undo the takeover", async () => {
    const lock = freshLock();

    await lock.tryAcquire(BUILD_LOCK_KEY, "a", 1_000, BUILD_LOCK_STALE_MS);
    const afterStale = 1_000 + BUILD_LOCK_STALE_MS;
    expect(await lock.tryAcquire(BUILD_LOCK_KEY, "b", afterStale, BUILD_LOCK_STALE_MS)).toBe(true);

    await lock.release(BUILD_LOCK_KEY, "a"); // the dead instance finally unwinds

    // "b" still holds it, so a third instance is still locked out.
    expect(await lock.tryAcquire(BUILD_LOCK_KEY, "c", afterStale + 1, BUILD_LOCK_STALE_MS)).toBe(
      false,
    );
  });

  test("creates its table idempotently across repeated calls on one client", async () => {
    const lock = freshLock();

    await lock.tryAcquire(BUILD_LOCK_KEY, "a", 1_000, BUILD_LOCK_STALE_MS);
    await lock.release(BUILD_LOCK_KEY, "a");
    await lock.tryAcquire(BUILD_LOCK_KEY, "a", 1_001, BUILD_LOCK_STALE_MS);

    expect(await lock.tryAcquire(BUILD_LOCK_KEY, "a", 1_002, BUILD_LOCK_STALE_MS)).toBe(true);
  });
});
