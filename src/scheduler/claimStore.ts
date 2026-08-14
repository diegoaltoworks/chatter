/**
 * A Turso-backed exactly-once claim: an atomic upsert means two instances
 * racing the same entry can never both believe they claimed it — see
 * `canClaim`, which mirrors `canAcquireLease` in
 * `../channels/whatsapp/lease.ts`. A failed send calls `release` to delete
 * the claim row, letting the entry be claimed again by whichever instance
 * ticks next within the grace window. An instance that dies mid-delivery
 * without releasing leaves its claim to go stale instead: after
 * `claimTimeoutMs` with no renewal, another instance may take it over.
 */

import type { Client } from "@libsql/client";
import type { ScheduleClaimStore } from "./types";

export const DEFAULT_CLAIM_TABLE = "chatter_schedule_claims";
/** How long an unreleased claim blocks reclaiming — short relative to a typical grace window, so a crashed claimant frees up in time for a retry to still land within grace. */
export const DEFAULT_CLAIM_TIMEOUT_MS = 2 * 60_000;

/** tableName is interpolated into SQL, so it is restricted to a plain identifier. */
const VALID_TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface ScheduleClaimRow {
  instanceId: string;
  claimedAt: number;
}

/**
 * Pure: may `instanceId` take (or keep) the claim on an entry right now,
 * given the current row (null = unclaimed)? Mirrors the SQL WHERE clause in
 * `createTursoScheduleClaimStore` — keep the two in sync.
 */
export function canClaim(
  existing: ScheduleClaimRow | null,
  instanceId: string,
  now: number,
  claimTimeoutMs: number,
): boolean {
  if (!existing) return true;
  if (existing.instanceId === instanceId) return true;
  return now - existing.claimedAt >= claimTimeoutMs;
}

const schemaReady = new WeakMap<Client, Map<string, Promise<unknown>>>();

function ensureSchema(client: Client, tableName: string): Promise<unknown> {
  let perTable = schemaReady.get(client);
  if (!perTable) {
    perTable = new Map();
    schemaReady.set(client, perTable);
  }
  let ready = perTable.get(tableName);
  if (!ready) {
    const table = perTable;
    ready = client
      .execute(
        `CREATE TABLE IF NOT EXISTS ${tableName} (
          schedule_id TEXT PRIMARY KEY,
          instance_id TEXT NOT NULL,
          claimed_at INTEGER NOT NULL
        )`,
      )
      .catch((error) => {
        table.delete(tableName); // don't cache a rejection — retry next call
        throw error;
      });
    perTable.set(tableName, ready);
  }
  return ready;
}

export function createTursoScheduleClaimStore(
  client: Client,
  instanceId: string,
  tableName: string = DEFAULT_CLAIM_TABLE,
  claimTimeoutMs: number = DEFAULT_CLAIM_TIMEOUT_MS,
): ScheduleClaimStore {
  if (!VALID_TABLE_NAME.test(tableName)) {
    throw new Error(`Invalid schedule claim table name: ${tableName}`);
  }
  return {
    async claim(id, now) {
      await ensureSchema(client, tableName);
      const result = await client.execute({
        sql: `INSERT INTO ${tableName} (schedule_id, instance_id, claimed_at) VALUES (?, ?, ?)
              ON CONFLICT(schedule_id) DO UPDATE SET
                instance_id = excluded.instance_id,
                claimed_at = excluded.claimed_at
              WHERE ${tableName}.instance_id = excluded.instance_id
                 OR ${tableName}.claimed_at <= excluded.claimed_at - ?
              RETURNING instance_id`,
        args: [id, instanceId, now, claimTimeoutMs],
      });
      const row = result.rows[0];
      return Boolean(row) && row.instance_id === instanceId;
    },
    async release(id) {
      await ensureSchema(client, tableName);
      await client.execute({
        sql: `DELETE FROM ${tableName} WHERE schedule_id = ? AND instance_id = ?`,
        args: [id, instanceId],
      });
    },
  };
}
