/**
 * Turso/libsql-backed {@link HistoryStore}.
 *
 * History lives in the database rather than process memory because
 * deployments run multiple instances, and the instance that handles turn 2
 * of a conversation is not guaranteed to be the one that handled turn 1.
 *
 * `@libsql/client` is imported for its type alone, so this module adds no
 * runtime dependency to anyone importing `./history` for the store contract.
 */

import type { Client } from "@libsql/client";
import type { HistoryMessage, HistoryStore } from "./types";

// Keyed per-client AND per-table, mirroring the usage/flow-session stores: an
// arbitrary Client may be shared across multiple history tables, and a single
// module-level promise would skip table creation for every table after the
// first one to run against that client.
const schemaReady = new WeakMap<Client, Map<string, Promise<unknown>>>();

function ensureHistorySchema(client: Client, tableName: string): Promise<unknown> {
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
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          conversation_id TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at INTEGER NOT NULL
        )`,
      )
      .then(() =>
        client.execute(
          `CREATE INDEX IF NOT EXISTS ${tableName}_conversation_idx ON ${tableName} (conversation_id, id)`,
        ),
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

const VALID_ROLES = new Set<HistoryMessage["role"]>(["user", "assistant"]);

const DEFAULT_MAX_PER_CONVERSATION = 200;

/** Default table name for {@link createTursoHistoryStore} when no `tableName` is given, mirroring `scheduler`'s `DEFAULT_CLAIM_TABLE`. */
export const DEFAULT_HISTORY_TABLE = "chat_history";

export interface TursoHistoryStoreOptions {
  /**
   * Retention window: rows older than this are pruned whenever the
   * conversation they belong to is accessed (`append` or `load`); there is
   * no background sweep. Unset: rows never expire on their own (only the
   * `maxPerConversation` count cap and explicit `clear` remove them). Must be
   * a positive integer, validated at construction like `maxPerConversation`.
   */
  ttlMs?: number;
  /** Injectable clock for tests. @default Date.now */
  now?: () => number;
}

/**
 * Creates a history store keyed by an arbitrary conversation id (a WhatsApp
 * chat jid, a phone call sid, a web session id) on `tableName`.
 *
 * `append` prunes each conversation back down to `maxPerConversation` after
 * every write, so the table stays bounded even for a conversation nobody
 * ever calls `load` on with a small `limit`; a caller's `limit` shapes what
 * a single `load` returns, not how much history physically accumulates. A
 * non-positive `maxPerConversation` would prune every write to nothing (`0`)
 * or disable pruning entirely (SQLite reads a negative `LIMIT` as
 * unlimited), so it is validated at construction the same way `tableName` is.
 */
export function createTursoHistoryStore(
  client: Client,
  tableName = DEFAULT_HISTORY_TABLE,
  maxPerConversation = DEFAULT_MAX_PER_CONVERSATION,
  options?: TursoHistoryStoreOptions,
): HistoryStore {
  if (!VALID_TABLE_NAME.test(tableName)) {
    throw new Error(`Invalid history store table name: ${tableName}`);
  }
  if (!Number.isInteger(maxPerConversation) || maxPerConversation < 1) {
    throw new Error(`Invalid history store maxPerConversation: ${maxPerConversation}`);
  }
  if (options?.ttlMs !== undefined && (!Number.isInteger(options.ttlMs) || options.ttlMs < 1)) {
    throw new Error(`Invalid history store ttlMs: ${options.ttlMs}`);
  }
  const ttlMs = options?.ttlMs;
  const now = options?.now ?? Date.now;

  async function pruneExpired(conversationId: string) {
    if (ttlMs === undefined) return;
    await client.execute({
      sql: `DELETE FROM ${tableName} WHERE conversation_id = ? AND created_at < ?`,
      args: [conversationId, now() - ttlMs],
    });
  }

  return {
    async append(conversationId, message: HistoryMessage) {
      await ensureHistorySchema(client, tableName);
      await pruneExpired(conversationId);
      await client.execute({
        sql: `INSERT INTO ${tableName} (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)`,
        args: [conversationId, message.role, message.content, now()],
      });
      await client.execute({
        sql: `DELETE FROM ${tableName} WHERE conversation_id = ? AND id NOT IN (
                SELECT id FROM ${tableName} WHERE conversation_id = ? ORDER BY id DESC LIMIT ?
              )`,
        args: [conversationId, conversationId, maxPerConversation],
      });
    },

    async load(conversationId, limit) {
      // A non-positive limit is a plain "load nothing" rather than SQLite's
      // "negative LIMIT means unlimited" — a caller passing 0 or a stray
      // negative must not get the entire conversation back.
      const boundedLimit = Math.max(0, Math.trunc(limit));
      if (boundedLimit === 0) return [];

      await ensureHistorySchema(client, tableName);
      await pruneExpired(conversationId);
      const result = await client.execute({
        sql: `SELECT role, content FROM ${tableName} WHERE conversation_id = ? ORDER BY id DESC LIMIT ?`,
        args: [conversationId, boundedLimit],
      });
      return (
        result.rows
          .map((row) => ({
            role: String(row.role) as HistoryMessage["role"],
            content: String(row.content),
          }))
          // A row with a role outside the contract (a hand-migrated table, a
          // host writing directly) must not reach a caller expecting only
          // "user"/"assistant" — silently dropped rather than fed to the model
          // as a bogus pipeline message.
          .filter((row) => VALID_ROLES.has(row.role))
          .reverse()
      );
    },

    async clear(conversationId) {
      await ensureHistorySchema(client, tableName);
      await client.execute({
        sql: `DELETE FROM ${tableName} WHERE conversation_id = ?`,
        args: [conversationId],
      });
    },
  };
}
