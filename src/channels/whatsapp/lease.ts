/**
 * Deploy-overlap protection: at most one running instance may hold a given
 * WhatsApp session's Baileys connection at a time.
 *
 * Rolling deploys can briefly run the outgoing and incoming revision side by
 * side, and Baileys/WhatsApp treats a second concurrent connection as a
 * takeover — it logs the first one out. The lease lives in Turso (`wa_lease`)
 * so it's visible to every instance. Acquiring/renewing is a single atomic
 * upsert — see `createTursoWaLeaseStore` — so two instances racing the same
 * row can never both believe they hold it.
 */

import type { Client } from "@libsql/client";

/** Stale after this long without a heartbeat — a crashed holder's lease frees up. */
export const LEASE_STALE_MS = 90_000;
/** How often a holder renews its lease while connected. */
export const LEASE_HEARTBEAT_MS = 30_000;
/** How long a non-holder waits before re-checking whether the lease freed up. */
export const LEASE_WAIT_MS = 30_000;

export interface WaLeaseRow {
  instanceId: string;
  heartbeatAt: number;
}

/**
 * Pure: may `instanceId` take (or keep) the lease right now, given the
 * current row (null = never held)? Mirrors the SQL WHERE clause in
 * `createTursoWaLeaseStore` — keep the two in sync.
 */
export function canAcquireLease(
  existing: WaLeaseRow | null,
  instanceId: string,
  now: number,
  staleMs: number = LEASE_STALE_MS,
): boolean {
  if (!existing) return true;
  if (existing.instanceId === instanceId) return true; // renew our own lease
  return now - existing.heartbeatAt >= staleMs; // previous holder went stale
}

export interface WaLeaseStore {
  /** Atomically acquires or renews the lease; resolves true iff `instanceId` now holds it. */
  tryAcquire(sessionId: string, instanceId: string, now: number, staleMs: number): Promise<boolean>;
  /** Releases the lease iff still held by `instanceId` (no-op otherwise — a late release must never undo a takeover). */
  release(sessionId: string, instanceId: string): Promise<void>;
}

const schemaReady = new WeakMap<Client, Promise<unknown>>();
function ensureWaLeaseSchema(client: Client): Promise<unknown> {
  let ready = schemaReady.get(client);
  if (!ready) {
    ready = client
      .execute(
        `CREATE TABLE IF NOT EXISTS wa_lease (
          session_id TEXT PRIMARY KEY,
          instance_id TEXT NOT NULL,
          heartbeat_at INTEGER NOT NULL
        )`,
      )
      .catch((error) => {
        schemaReady.delete(client);
        throw error;
      });
    schemaReady.set(client, ready);
  }
  return ready;
}

/**
 * A Turso-backed `WaLeaseStore`. The WHERE clause on DO UPDATE encodes
 * `canAcquireLease`: SQLite skips the update (and RETURNING yields no row)
 * when it's false, so a losing racer sees zero rows back — no separate
 * read-then-write, no race window.
 */
export function createTursoWaLeaseStore(client: Client): WaLeaseStore {
  return {
    async tryAcquire(sessionId, instanceId, now, staleMs) {
      await ensureWaLeaseSchema(client);
      const result = await client.execute({
        sql: `INSERT INTO wa_lease (session_id, instance_id, heartbeat_at) VALUES (?, ?, ?)
              ON CONFLICT(session_id) DO UPDATE SET
                instance_id = excluded.instance_id,
                heartbeat_at = excluded.heartbeat_at
              WHERE wa_lease.instance_id = excluded.instance_id
                 OR wa_lease.heartbeat_at <= excluded.heartbeat_at - ?
              RETURNING instance_id`,
        args: [sessionId, instanceId, now, staleMs],
      });
      const row = result.rows[0];
      return Boolean(row) && row.instance_id === instanceId;
    },
    async release(sessionId, instanceId) {
      await ensureWaLeaseSchema(client);
      await client.execute({
        sql: "DELETE FROM wa_lease WHERE session_id = ? AND instance_id = ?",
        args: [sessionId, instanceId],
      });
    },
  };
}
