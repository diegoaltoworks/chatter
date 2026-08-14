/**
 * Turso usage store tests.
 *
 * Run against a real in-memory libsql client rather than a fake, because the
 * properties worth proving here are SQL-level: the upsert is atomic, it hands
 * every concurrent caller a distinct number, and table creation is idempotent.
 */

import { describe, expect, test } from "bun:test";
import { type Client, createClient, type InStatement } from "@libsql/client";
import { createDailyLimiter } from "./limits";
import { createTursoUsageStore } from "./tursoStore";

function memoryClient() {
  return createClient({ url: ":memory:" });
}

describe("createTursoUsageStore", () => {
  test("rejects table names that are not plain identifiers", () => {
    const client = memoryClient();

    for (const name of ["usage; DROP TABLE x", "usage-counts", "1usage", "", "usage counts"]) {
      expect(() => createTursoUsageStore(client, name)).toThrow("Invalid usage store table name");
    }
  });

  test("accepts plain identifiers", () => {
    const client = memoryClient();

    expect(() => createTursoUsageStore(client, "image_usage")).not.toThrow();
    expect(() => createTursoUsageStore(client, "_usage2")).not.toThrow();
  });

  test("creates its table on first use and counts from one", async () => {
    const store = createTursoUsageStore(memoryClient(), "image_usage");

    expect(await store.incrementAndGet("key", "a", "2026-08-01")).toBe(1);
    expect(await store.incrementAndGet("key", "a", "2026-08-01")).toBe(2);
  });

  test("keeps scope, key and day as separate counters", async () => {
    const store = createTursoUsageStore(memoryClient(), "image_usage");

    await store.incrementAndGet("key", "a", "2026-08-01");

    expect(await store.incrementAndGet("key", "b", "2026-08-01")).toBe(1);
    expect(await store.incrementAndGet("key", "a", "2026-08-02")).toBe(1);
    expect(await store.incrementAndGet("global", "a", "2026-08-01")).toBe(1);
  });

  // The load-bearing half of multi-instance safety: overlapping increments each
  // get a distinct post-increment number, so no two callers can read the same
  // count and both conclude there is room under the cap. Genuinely separate
  // connections would exercise the rest, which is the database's guarantee
  // rather than this module's.
  test("concurrent increments each return a distinct count", async () => {
    const store = createTursoUsageStore(memoryClient(), "image_usage");

    const counts = await Promise.all(
      Array.from({ length: 20 }, () => store.incrementAndGet("key", "a", "2026-08-01")),
    );

    expect([...counts].sort((x, y) => x - y)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  test("separate tables on one client get separate schemas and counters", async () => {
    const client = memoryClient();
    const images = createTursoUsageStore(client, "image_usage");
    const voice = createTursoUsageStore(client, "voice_usage");

    await images.incrementAndGet("key", "a", "2026-08-01");

    expect(await voice.incrementAndGet("key", "a", "2026-08-01")).toBe(1);
  });

  test("table creation is idempotent across stores sharing a table", async () => {
    const client = memoryClient();
    const first = createTursoUsageStore(client, "image_usage");
    const second = createTursoUsageStore(client, "image_usage");

    await first.incrementAndGet("key", "a", "2026-08-01");

    expect(await second.incrementAndGet("key", "a", "2026-08-01")).toBe(2);
  });

  // The memo caches the in-flight CREATE TABLE promise. If it cached a
  // rejected one, a single transient blip would wedge the store for the
  // lifetime of the client.
  test("retries table creation after a failed attempt instead of caching the rejection", async () => {
    let createAttempts = 0;
    const real = memoryClient();
    const flaky = {
      ...real,
      execute(stmt: InStatement) {
        const sql = typeof stmt === "string" ? stmt : stmt.sql;
        if (sql.includes("CREATE TABLE")) {
          createAttempts += 1;
          if (createAttempts === 1) return Promise.reject(new Error("connection reset"));
        }
        return real.execute(stmt);
      },
    } as unknown as Client;

    const store = createTursoUsageStore(flaky, "image_usage");

    await expect(store.incrementAndGet("key", "a", "2026-08-01")).rejects.toThrow(
      "connection reset",
    );
    await expect(store.incrementAndGet("key", "a", "2026-08-01")).resolves.toBe(1);
    expect(createAttempts).toBe(2);
  });

  // A spend guard must not fail open: no row back means the count is unknown,
  // which has to raise rather than resolve to something permissive.
  test("throws when the upsert returns no row", async () => {
    const real = memoryClient();
    const rowless = {
      ...real,
      async execute(stmt: InStatement) {
        const sql = typeof stmt === "string" ? stmt : stmt.sql;
        if (sql.includes("CREATE TABLE")) return real.execute(stmt);
        return { ...(await real.execute(stmt)), rows: [] };
      },
    } as unknown as Client;

    const store = createTursoUsageStore(rowless, "image_usage");

    await expect(store.incrementAndGet("key", "a", "2026-08-01")).rejects.toThrow(
      "image_usage returned no row from upsert",
    );
  });

  test("drives a limiter end to end", async () => {
    const store = createTursoUsageStore(memoryClient(), "image_usage");
    const limiter = createDailyLimiter({ perKeyDailyLimit: 1, globalDailyLimit: 10 }, { store });

    expect(await limiter.checkAndReserve("a")).toEqual({ allowed: true, reason: null });
    expect(await limiter.checkAndReserve("a")).toEqual({ allowed: false, reason: "per-key" });
  });
});
