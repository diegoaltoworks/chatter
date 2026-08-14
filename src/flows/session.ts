/**
 * Turso/libsql-backed {@link FlowSessionStore}.
 *
 * Session state lives in the database rather than process memory because
 * deployments run multiple instances — the instance that handles turn 2 of a
 * multi-turn flow is not guaranteed to be the one that handled turn 1.
 *
 * `@libsql/client` is imported for its type alone, so this module adds no
 * runtime dependency to anyone importing `./flows` for the pure engine.
 */

import type { Client } from "@libsql/client";
import type { FlowSessionState, FlowSessionStore } from "./types";

// Keyed per-client AND per-table, mirroring the usage store: an arbitrary
// Client may be shared across multiple flow session tables, and a single
// module-level promise would skip table creation for every table after the
// first one to run against that client.
const schemaReady = new WeakMap<Client, Map<string, Promise<unknown>>>();

function ensureSessionSchema(client: Client, tableName: string): Promise<unknown> {
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
          session_key TEXT PRIMARY KEY,
          flow_id TEXT NOT NULL,
          params TEXT NOT NULL,
          attempts INTEGER NOT NULL,
          started_at INTEGER NOT NULL
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

/** Creates a session store keyed by an arbitrary session id (phone number, WhatsApp JID, web session id) on `tableName`. */
export function createTursoFlowSessionStore(
  client: Client,
  tableName = "flow_sessions",
): FlowSessionStore {
  if (!VALID_TABLE_NAME.test(tableName)) {
    throw new Error(`Invalid flow session store table name: ${tableName}`);
  }

  return {
    async get(sessionKey) {
      await ensureSessionSchema(client, tableName);
      const result = await client.execute({
        sql: `SELECT flow_id, params, attempts, started_at FROM ${tableName} WHERE session_key = ?`,
        args: [sessionKey],
      });
      const row = result.rows[0];
      if (!row) return null;
      return {
        flowId: String(row.flow_id),
        params: JSON.parse(String(row.params)) as Record<string, unknown>,
        attempts: Number(row.attempts),
        startedAt: Number(row.started_at),
      };
    },

    async set(sessionKey, state: FlowSessionState) {
      await ensureSessionSchema(client, tableName);
      await client.execute({
        sql: `INSERT INTO ${tableName} (session_key, flow_id, params, attempts, started_at) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(session_key) DO UPDATE SET flow_id = excluded.flow_id, params = excluded.params, attempts = excluded.attempts, started_at = excluded.started_at`,
        args: [
          sessionKey,
          state.flowId,
          JSON.stringify(state.params),
          state.attempts,
          state.startedAt,
        ],
      });
    },

    async clear(sessionKey) {
      await ensureSessionSchema(client, tableName);
      await client.execute({
        sql: `DELETE FROM ${tableName} WHERE session_key = ?`,
        args: [sessionKey],
      });
    },
  };
}
