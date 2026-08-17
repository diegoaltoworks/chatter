/**
 * Single-writer lock around the destructive half of a knowledge-base build.
 *
 * `VectorStore.build()` is a read-diff-delete-insert sequence: it reads the
 * chunk ids already in the database, computes the ids its own `knowledgeDir`
 * produces, and deletes everything not in that set. Two instances booting
 * against the same database at the same time (a rolling deploy, a manual
 * deploy racing an automated one) each run that sequence against a view of
 * the data the other is still mutating, so one boot's cleanup can delete
 * chunks the other has just written or has not finished writing.
 *
 * The lock lives in the same database (`chatter_build_lock`) so it is visible
 * to every instance, and acquiring or renewing it is a single atomic upsert
 * (see `createTursoBuildLock`) - two instances racing the same key can never
 * both believe they hold it. A holder that dies without releasing leaves a
 * stale row instead of wedging every future boot: after `staleMs` with no
 * heartbeat, the next instance may take it over.
 */

import type { Client } from "@libsql/client";

/** Lock key for the knowledge-base build. One build runs per database at a time. */
export const BUILD_LOCK_KEY = "knowledge_build";

/**
 * A held lock this old with no heartbeat is treated as abandoned. Generous
 * because a first build embeds every chunk it loads, which can take minutes;
 * a holder renews the lock as it goes (see `VectorStore.build`), so only a
 * process that actually died lets the lock go stale.
 */
export const BUILD_LOCK_STALE_MS = 10 * 60_000;

export interface BuildLockRow {
  holderId: string;
  heartbeatAt: number;
}

/**
 * Pure: may `holderId` take (or keep) the build lock right now, given the
 * current row (null = never held)? Mirrors the SQL WHERE clause in
 * `createTursoBuildLock` - keep the two in sync.
 */
export function canAcquireBuildLock(
  existing: BuildLockRow | null,
  holderId: string,
  now: number,
  staleMs: number = BUILD_LOCK_STALE_MS,
): boolean {
  if (!existing) return true;
  if (existing.holderId === holderId) return true; // renew our own lock
  return now - existing.heartbeatAt >= staleMs; // previous holder went stale
}

export interface BuildLock {
  /** Atomically acquires or renews the lock; resolves true iff `holderId` now holds it. */
  tryAcquire(key: string, holderId: string, now: number, staleMs: number): Promise<boolean>;
  /** Releases the lock iff still held by `holderId` (no-op otherwise, so a late release never undoes a takeover). */
  release(key: string, holderId: string): Promise<void>;
}

const schemaReady = new WeakMap<Client, Promise<unknown>>();

function ensureBuildLockSchema(client: Client): Promise<unknown> {
  let ready = schemaReady.get(client);
  if (!ready) {
    ready = client
      .execute(
        `CREATE TABLE IF NOT EXISTS chatter_build_lock (
          lock_key TEXT PRIMARY KEY,
          holder_id TEXT NOT NULL,
          heartbeat_at INTEGER NOT NULL
        )`,
      )
      .catch((error) => {
        schemaReady.delete(client); // don't cache a rejection, retry next call
        throw error;
      });
    schemaReady.set(client, ready);
  }
  return ready;
}

/**
 * A libsql-backed {@link BuildLock}. The WHERE clause on DO UPDATE encodes
 * `canAcquireBuildLock`: SQLite skips the update (and RETURNING yields no
 * row) when it is false, so a losing racer sees zero rows back - no separate
 * read-then-write, no race window.
 */
export function createTursoBuildLock(client: Client): BuildLock {
  return {
    async tryAcquire(key, holderId, now, staleMs) {
      await ensureBuildLockSchema(client);
      const result = await client.execute({
        sql: `INSERT INTO chatter_build_lock (lock_key, holder_id, heartbeat_at) VALUES (?, ?, ?)
              ON CONFLICT(lock_key) DO UPDATE SET
                holder_id = excluded.holder_id,
                heartbeat_at = excluded.heartbeat_at
              WHERE chatter_build_lock.holder_id = excluded.holder_id
                 OR chatter_build_lock.heartbeat_at <= excluded.heartbeat_at - ?
              RETURNING holder_id`,
        args: [key, holderId, now, staleMs],
      });
      const row = result.rows[0];
      return Boolean(row) && row.holder_id === holderId;
    },
    async release(key, holderId) {
      await ensureBuildLockSchema(client);
      await client.execute({
        sql: "DELETE FROM chatter_build_lock WHERE lock_key = ? AND holder_id = ?",
        args: [key, holderId],
      });
    },
  };
}
