import { describe, expect, test } from "bun:test";
import { createClient } from "@libsql/client";
import { canClaim, createTursoScheduleClaimStore } from "./claimStore";

function memoryClient() {
  return createClient({ url: ":memory:" });
}

describe("canClaim", () => {
  test("grants an unclaimed entry", () => {
    expect(canClaim(null, "instance-a", 1_000, 500)).toBe(true);
  });

  test("lets the current holder renew", () => {
    const existing = { instanceId: "instance-a", claimedAt: 1_000 };

    expect(canClaim(existing, "instance-a", 1_010, 500)).toBe(true);
  });

  test("denies a different instance while the holder is fresh", () => {
    const existing = { instanceId: "instance-a", claimedAt: 1_000 };

    expect(canClaim(existing, "instance-b", 1_499, 500)).toBe(false);
  });

  test("lets a different instance take over once the holder goes stale", () => {
    const existing = { instanceId: "instance-a", claimedAt: 1_000 };

    expect(canClaim(existing, "instance-b", 1_500, 500)).toBe(true);
  });
});

describe("createTursoScheduleClaimStore", () => {
  test("first claim succeeds; a second instance is refused", async () => {
    const client = memoryClient();
    const a = createTursoScheduleClaimStore(client, "instance-a");
    const b = createTursoScheduleClaimStore(client, "instance-b");

    expect(await a.claim("job-1", 1_000)).toBe(true);
    expect(await b.claim("job-1", 1_010)).toBe(false);
  });

  test("entries are independent", async () => {
    const client = memoryClient();
    const store = createTursoScheduleClaimStore(client, "instance-a");

    expect(await store.claim("job-1", 1_000)).toBe(true);
    expect(await store.claim("job-2", 1_000)).toBe(true);
  });

  test("release lets another instance claim again", async () => {
    const client = memoryClient();
    const a = createTursoScheduleClaimStore(client, "instance-a");
    const b = createTursoScheduleClaimStore(client, "instance-b");

    await a.claim("job-1", 1_000);
    await a.release("job-1");

    expect(await b.claim("job-1", 1_010)).toBe(true);
  });

  test("release from a non-holder is a no-op", async () => {
    const client = memoryClient();
    const a = createTursoScheduleClaimStore(client, "instance-a");
    const b = createTursoScheduleClaimStore(client, "instance-b");

    await a.claim("job-1", 1_000);
    await b.release("job-1");

    expect(await b.claim("job-1", 1_010)).toBe(false);
  });

  test("the holder can renew its own claim", async () => {
    const client = memoryClient();
    const store = createTursoScheduleClaimStore(client, "instance-a");

    await store.claim("job-1", 1_000);

    expect(await store.claim("job-1", 1_010)).toBe(true);
  });

  test("an unreleased claim can be taken over by another instance once it goes stale", async () => {
    const client = memoryClient();
    const a = createTursoScheduleClaimStore(client, "instance-a", undefined, 500);
    const b = createTursoScheduleClaimStore(client, "instance-b", undefined, 500);

    await a.claim("job-1", 1_000);

    expect(await b.claim("job-1", 1_000 + 499)).toBe(false);
    expect(await b.claim("job-1", 1_000 + 500)).toBe(true);
  });

  test("concurrent claims on the same entry grant exactly one instance", async () => {
    const client = memoryClient();
    const stores = Array.from({ length: 10 }, (_, i) =>
      createTursoScheduleClaimStore(client, `instance-${i}`),
    );

    const results = await Promise.all(stores.map((store) => store.claim("job-1", 1_000)));

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  test("rejects table names that are not plain identifiers", () => {
    const client = memoryClient();
    expect(() => createTursoScheduleClaimStore(client, "instance-a", "bad; DROP TABLE x")).toThrow(
      "Invalid schedule claim table name",
    );
  });
});
