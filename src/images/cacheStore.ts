/**
 * Turso/libsql-backed {@link ImageCacheStore}.
 *
 * Schema and upsert only, mirroring `../usage/tursoStore`: idempotent table
 * creation memoized per (client, table), and a table name restricted to a
 * plain identifier since it is interpolated into SQL.
 *
 * `@libsql/client` is imported for its type alone, so this module adds no
 * runtime dependency to anyone importing `./cache` for the pure key/freshness
 * helpers.
 */

import type { Client } from "@libsql/client";
import type { ImageCacheEntry, ImageCacheStore } from "./cache";

const schemaReady = new WeakMap<Client, Map<string, Promise<unknown>>>();

function ensureCacheSchema(client: Client, tableName: string): Promise<unknown> {
  let perTable = schemaReady.get(client);
  if (!perTable) {
    perTable = new Map();
    schemaReady.set(client, perTable);
  }
  const tables = perTable;
  let ready = tables.get(tableName);
  if (!ready) {
    ready = client
      .execute(
        `CREATE TABLE IF NOT EXISTS ${tableName} (
          public_id TEXT PRIMARY KEY,
          url TEXT NOT NULL,
          created_at INTEGER NOT NULL
        )`,
      )
      .catch((error) => {
        // Drop the memo so the next call retries: a cached rejection would
        // wedge the store permanently after one transient connection blip.
        tables.delete(tableName);
        throw error;
      });
    tables.set(tableName, ready);
  }
  return ready;
}

/** `tableName` is interpolated into SQL, so it is restricted to a plain identifier. */
const VALID_TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Creates a cache store backed by `tableName` on `client`. Table creation is
 * idempotent and happens once per (client, table); give each cached resource
 * its own table.
 */
export function createTursoImageCacheStore(client: Client, tableName: string): ImageCacheStore {
  if (!VALID_TABLE_NAME.test(tableName)) {
    throw new Error(`Invalid image cache table name: ${tableName}`);
  }

  return {
    async get(key: string): Promise<ImageCacheEntry | null> {
      await ensureCacheSchema(client, tableName);
      const result = await client.execute({
        sql: `SELECT url, created_at FROM ${tableName} WHERE public_id = ?`,
        args: [key],
      });
      const row = result.rows[0];
      if (!row) return null;
      return { url: String(row.url), createdAt: Number(row.created_at) };
    },

    async set(key: string, entry: ImageCacheEntry): Promise<void> {
      await ensureCacheSchema(client, tableName);
      await client.execute({
        sql: `INSERT INTO ${tableName} (public_id, url, created_at) VALUES (?, ?, ?)
              ON CONFLICT(public_id) DO UPDATE SET url = excluded.url, created_at = excluded.created_at`,
        args: [key, entry.url, entry.createdAt],
      });
    },
  };
}
