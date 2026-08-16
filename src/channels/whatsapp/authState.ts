/**
 * Baileys auth state, encrypted at rest, over an injectable {@link WaAuthKV}.
 *
 * Same contract as Baileys' own `useMultiFileAuthState`, but rows in a
 * key-value store instead of files, AES-GCM encrypted (see `crypto.ts`) so
 * session material - which grants full account access - is never stored
 * readable. The store itself only ever sees ciphertext: encryption lives in
 * this module, above the store, so a custom `WaAuthKV` cannot accidentally
 * persist plaintext session material.
 *
 * Only Baileys *types* are imported here (erased at compile time, so they add
 * no runtime dependency); the few Baileys runtime values this module needs
 * (`BufferJSON`, `initAuthCreds`, the app-state-sync-key constructor) are
 * passed in by the caller, which already holds them from the dynamic import
 * in `baileys.ts` - see that module for why the import is dynamic.
 */

import type { Client } from "@libsql/client";
import type {
  AuthenticationCreds,
  AuthenticationState,
  SignalDataTypeMap,
} from "@whiskeysockets/baileys";
import { decrypt, encrypt } from "./crypto";

export interface TursoAuthStateResult {
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
  /** Wipe the stored session (unlink / re-pair). */
  clear: () => Promise<void>;
}

/** The slice of the dynamically-loaded Baileys module this file needs at runtime. */
export interface AuthStateRuntime {
  bufferJSON: {
    replacer: (key: string, value: unknown) => unknown;
    reviver: (key: string, value: unknown) => unknown;
  };
  initAuthCreds: () => AuthenticationCreds;
  appStateSyncKeyFromObject: (
    value: Record<string, unknown>,
  ) => SignalDataTypeMap["app-state-sync-key"];
}

/**
 * Raw storage for Baileys auth rows, keyed by an already session-scoped
 * `id` (see `useAuthState`'s `rowId`). Values are opaque ciphertext strings -
 * this layer has no encryption knowledge, only persistence.
 */
export interface WaAuthKV {
  read(id: string): Promise<string | null>;
  write(id: string, value: string): Promise<void>;
  remove(id: string): Promise<void>;
  /**
   * Deletes every row belonging to `sessionId` and no other session's -
   * use {@link isAuthRowForSession} to decide which stored ids qualify
   * rather than re-deriving the "default" session's unprefixed special case
   * by hand; getting this wrong logs out a sibling number.
   */
  clear(sessionId: string): Promise<void>;
}

/**
 * Pure: does row id `id` (as stored - already passed through `rowId`) belong
 * to `sessionId`? Mirrors `useAuthState`'s `rowId` and the SQL in
 * `createTursoWaAuthKV`'s `clear` - keep the three in sync. The "default"
 * session's rows are UNPREFIXED (see `useAuthState`), so its scope is
 * everything *not* claimed by a named session's `s:<sessionId>/` prefix.
 */
export function isAuthRowForSession(id: string, sessionId: string): boolean {
  if (sessionId === "default") return !id.startsWith("s:");
  return id.startsWith(`s:${sessionId}/`);
}

const schemaReady = new WeakMap<Client, Promise<unknown>>();
function ensureAuthSchema(client: Client): Promise<unknown> {
  let ready = schemaReady.get(client);
  if (!ready) {
    ready = client
      .execute("CREATE TABLE IF NOT EXISTS wa_auth (id TEXT PRIMARY KEY, value TEXT NOT NULL)")
      .catch((error) => {
        schemaReady.delete(client);
        throw error;
      });
    schemaReady.set(client, ready);
  }
  return ready;
}

/** The shipped `WaAuthKV`: a `wa_auth` table in the same libsql database the rest of chatter uses. */
export function createTursoWaAuthKV(db: Client): WaAuthKV {
  return {
    async read(id) {
      await ensureAuthSchema(db);
      const result = await db.execute({
        sql: "SELECT value FROM wa_auth WHERE id = ?",
        args: [id],
      });
      const row = result.rows[0];
      return row ? (row.value as string) : null;
    },
    async write(id, value) {
      await ensureAuthSchema(db);
      await db.execute({
        sql: "INSERT OR REPLACE INTO wa_auth (id, value) VALUES (?, ?)",
        args: [id, value],
      });
    },
    async remove(id) {
      await ensureAuthSchema(db);
      await db.execute({ sql: "DELETE FROM wa_auth WHERE id = ?", args: [id] });
    },
    // Mirrors isAuthRowForSession - keep the two in sync.
    async clear(sessionId) {
      await ensureAuthSchema(db);
      if (sessionId === "default") {
        await db.execute("DELETE FROM wa_auth WHERE id NOT LIKE 's:%'");
      } else {
        await db.execute({
          sql: "DELETE FROM wa_auth WHERE id LIKE ?",
          args: [`s:${sessionId}/%`],
        });
      }
    },
  };
}

/**
 * Sessions share one `WaAuthKV`, namespaced by row-id prefix. The "default"
 * session uses UNPREFIXED ids - exactly a single-session layout - so an
 * existing default session needs no migration when multi-session support is
 * introduced.
 */
export async function useAuthState(
  store: WaAuthKV,
  secret: string,
  sessionId: string,
  runtime: AuthStateRuntime,
): Promise<TursoAuthStateResult> {
  // "s:" marker prefix cannot collide with Baileys ids (creds, pre-key-...,
  // session-..., app-state-sync-...), so legacy default rows stay unambiguous.
  const rowId = (id: string) => (sessionId === "default" ? id : `s:${sessionId}/${id}`);

  async function read(id: string): Promise<unknown | null> {
    const value = await store.read(rowId(id));
    if (value === null) return null;
    return JSON.parse(await decrypt(value, secret), runtime.bufferJSON.reviver);
  }

  async function write(id: string, value: unknown): Promise<void> {
    const payload = await encrypt(JSON.stringify(value, runtime.bufferJSON.replacer), secret);
    await store.write(rowId(id), payload);
  }

  async function remove(id: string): Promise<void> {
    await store.remove(rowId(id));
  }

  const creds = ((await read("creds")) as AuthenticationCreds | null) ?? runtime.initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
          const data: { [id: string]: SignalDataTypeMap[T] } = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = (await read(`${type}-${id}`)) as SignalDataTypeMap[T] | null;
              if (type === "app-state-sync-key" && value) {
                value = runtime.appStateSyncKeyFromObject(
                  value as unknown as Record<string, unknown>,
                ) as unknown as SignalDataTypeMap[T];
              }
              if (value) data[id] = value;
            }),
          );
          return data;
        },
        set: async (data) => {
          const jobs: Promise<void>[] = [];
          for (const category of Object.keys(data) as (keyof SignalDataTypeMap)[]) {
            const entries = data[category];
            if (!entries) continue;
            for (const id of Object.keys(entries)) {
              const value = entries[id];
              jobs.push(value ? write(`${category}-${id}`, value) : remove(`${category}-${id}`));
            }
          }
          await Promise.all(jobs);
        },
      },
    },
    saveCreds: () => write("creds", creds),
    // Scoped to THIS session - never nuke a sibling number's pairing.
    clear: () => store.clear(sessionId),
  };
}

/** Convenience wrapper over `useAuthState` for the shipped Turso-backed `WaAuthKV`. */
export async function useTursoAuthState(
  db: Client,
  secret: string,
  sessionId: string,
  runtime: AuthStateRuntime,
): Promise<TursoAuthStateResult> {
  return useAuthState(createTursoWaAuthKV(db), secret, sessionId, runtime);
}
