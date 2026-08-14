/**
 * Turso/libsql-backed {@link DailyLimitsStore}.
 *
 * Schema and upsert only — error typing and wrapping stay with the caller,
 * because each metered feature wants its own error contract and this layer
 * should not invent one for them.
 *
 * `@libsql/client` is imported for its type alone, so this module adds no
 * runtime dependency to anyone importing `./usage` for the pure limiter.
 */

import type { Client } from "@libsql/client";
import type { DailyLimitsStore } from "./limits";

// Keyed per-client AND per-table (not a single module-level promise): callers
// pass an arbitrary Client so tests can exercise this against a real in-memory
// libsql client, and a single memo-per-client would silently skip table
// creation for every table after the first one to run against that client.
const schemaReady = new WeakMap<Client, Map<string, Promise<unknown>>>();

function ensureUsageSchema(client: Client, tableName: string): Promise<unknown> {
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
          scope TEXT NOT NULL,
          key TEXT NOT NULL,
          day TEXT NOT NULL,
          count INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (scope, key, day)
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
 * Creates a store that counts into `tableName` on `client`.
 *
 * The upsert is a single atomic statement returning the post-increment count,
 * so concurrent instances each get a distinct number and the cap holds across
 * a multi-instance deployment. Table creation is idempotent and happens once
 * per (client, table).
 *
 * Give each metered resource its own table — sharing one would make separate
 * features compete for a single global counter.
 */
export function createTursoUsageStore(client: Client, tableName: string): DailyLimitsStore {
  if (!VALID_TABLE_NAME.test(tableName)) {
    throw new Error(`Invalid usage store table name: ${tableName}`);
  }

  return {
    async incrementAndGet(scope, key, day) {
      await ensureUsageSchema(client, tableName);
      const result = await client.execute({
        sql: `INSERT INTO ${tableName} (scope, key, day, count) VALUES (?, ?, ?, 1)
              ON CONFLICT(scope, key, day) DO UPDATE SET count = count + 1
              RETURNING count`,
        args: [scope, key, day],
      });
      const row = result.rows[0];
      // An unqualified upsert always returns exactly one row; a spend guard
      // must not fail open if that ever stops being true.
      if (!row) {
        throw new Error(`${tableName} returned no row from upsert`);
      }
      return Number(row.count);
    },
  };
}
