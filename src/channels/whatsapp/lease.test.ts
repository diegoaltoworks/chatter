import { describe, expect, test } from "bun:test";
import { createClient } from "@libsql/client";
import { canAcquireLease, createTursoWaLeaseStore, LEASE_STALE_MS } from "./lease";

function memoryClient() {
  return createClient({ url: ":memory:" });
}

describe("canAcquireLease", () => {
  test("grants an unheld lease", () => {
    expect(canAcquireLease(null, "instance-a", 1_000)).toBe(true);
  });

  test("lets the current holder renew", () => {
    const existing = { instanceId: "instance-a", heartbeatAt: 1_000 };

    expect(canAcquireLease(existing, "instance-a", 1_010)).toBe(true);
  });

  test("denies a different instance while the holder is fresh", () => {
    const existing = { instanceId: "instance-a", heartbeatAt: 1_000 };

    expect(canAcquireLease(existing, "instance-b", 1_000 + LEASE_STALE_MS - 1)).toBe(false);
  });

  test("lets a different instance take over once the holder goes stale", () => {
    const existing = { instanceId: "instance-a", heartbeatAt: 1_000 };

    expect(canAcquireLease(existing, "instance-b", 1_000 + LEASE_STALE_MS)).toBe(true);
  });

  test("honours a custom staleMs", () => {
    const existing = { instanceId: "instance-a", heartbeatAt: 1_000 };

    expect(canAcquireLease(existing, "instance-b", 1_150, 100)).toBe(true);
    expect(canAcquireLease(existing, "instance-b", 1_150, 200)).toBe(false);
  });
});

describe("createTursoWaLeaseStore", () => {
  test("first acquirer holds the lease; a second instance is refused", async () => {
    const store = createTursoWaLeaseStore(memoryClient());

    expect(await store.tryAcquire("default", "instance-a", 1_000, LEASE_STALE_MS)).toBe(true);
    expect(await store.tryAcquire("default", "instance-b", 1_010, LEASE_STALE_MS)).toBe(false);
  });

  test("the holder can renew its own lease", async () => {
    const store = createTursoWaLeaseStore(memoryClient());

    await store.tryAcquire("default", "instance-a", 1_000, LEASE_STALE_MS);

    expect(await store.tryAcquire("default", "instance-a", 1_010, LEASE_STALE_MS)).toBe(true);
  });

  test("a stale lease can be taken over by another instance", async () => {
    const store = createTursoWaLeaseStore(memoryClient());

    await store.tryAcquire("default", "instance-a", 1_000, LEASE_STALE_MS);

    expect(
      await store.tryAcquire("default", "instance-b", 1_000 + LEASE_STALE_MS, LEASE_STALE_MS),
    ).toBe(true);
    // instance-a is now locked out — the takeover is exclusive, not shared.
    expect(
      await store.tryAcquire("default", "instance-a", 1_000 + LEASE_STALE_MS + 10, LEASE_STALE_MS),
    ).toBe(false);
  });

  test("sessions are independent", async () => {
    const store = createTursoWaLeaseStore(memoryClient());

    expect(await store.tryAcquire("number-1", "instance-a", 1_000, LEASE_STALE_MS)).toBe(true);
    expect(await store.tryAcquire("number-2", "instance-b", 1_000, LEASE_STALE_MS)).toBe(true);
  });

  test("release frees the lease for another instance", async () => {
    const store = createTursoWaLeaseStore(memoryClient());

    await store.tryAcquire("default", "instance-a", 1_000, LEASE_STALE_MS);
    await store.release("default", "instance-a");

    expect(await store.tryAcquire("default", "instance-b", 1_010, LEASE_STALE_MS)).toBe(true);
  });

  test("a release from a non-holder is a no-op — a late release must never undo a takeover", async () => {
    const store = createTursoWaLeaseStore(memoryClient());

    await store.tryAcquire("default", "instance-a", 1_000, LEASE_STALE_MS);
    await store.tryAcquire("default", "instance-b", 1_000 + LEASE_STALE_MS, LEASE_STALE_MS);

    // instance-a's late release must not touch instance-b's lease.
    await store.release("default", "instance-a");

    expect(
      await store.tryAcquire("default", "instance-a", 1_000 + LEASE_STALE_MS + 10, LEASE_STALE_MS),
    ).toBe(false);
  });

  test("concurrent first acquires on the same session grant exactly one instance", async () => {
    const store = createTursoWaLeaseStore(memoryClient());

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        store.tryAcquire("default", `instance-${i}`, 1_000, LEASE_STALE_MS),
      ),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
