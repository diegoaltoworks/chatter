/**
 * Turso image cache store tests.
 *
 * Run against a real in-memory libsql client, same rationale as
 * `../usage/tursoStore.test.ts`: the properties worth proving are SQL-level.
 */

import { describe, expect, test } from "bun:test";
import { createClient } from "@libsql/client";
import { createTursoImageCacheStore } from "./cacheStore";

function memoryClient() {
  return createClient({ url: ":memory:" });
}

describe("createTursoImageCacheStore", () => {
  test("rejects table names that are not plain identifiers", () => {
    const client = memoryClient();

    for (const name of ["cache; DROP TABLE x", "image-cache", "1cache", "", "image cache"]) {
      expect(() => createTursoImageCacheStore(client, name)).toThrow(
        "Invalid image cache table name",
      );
    }
  });

  test("get returns null for a missing key", async () => {
    const store = createTursoImageCacheStore(memoryClient(), "image_cache");
    expect(await store.get("missing")).toBeNull();
  });

  test("round-trips a stored entry", async () => {
    const store = createTursoImageCacheStore(memoryClient(), "image_cache");

    await store.set("abc", { url: "https://example.com/a.png", createdAt: 1000 });

    expect(await store.get("abc")).toEqual({ url: "https://example.com/a.png", createdAt: 1000 });
  });

  test("set overwrites an existing entry for the same key", async () => {
    const store = createTursoImageCacheStore(memoryClient(), "image_cache");

    await store.set("abc", { url: "https://example.com/old.png", createdAt: 1000 });
    await store.set("abc", { url: "https://example.com/new.png", createdAt: 2000 });

    expect(await store.get("abc")).toEqual({ url: "https://example.com/new.png", createdAt: 2000 });
  });

  test("separate tables on one client get separate rows", async () => {
    const client = memoryClient();
    const a = createTursoImageCacheStore(client, "image_cache_a");
    const b = createTursoImageCacheStore(client, "image_cache_b");

    await a.set("abc", { url: "https://example.com/a.png", createdAt: 1000 });

    expect(await b.get("abc")).toBeNull();
  });
});
