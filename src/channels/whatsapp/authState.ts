/**
 * Turso/libsql-backed Baileys auth state, encrypted at rest.
 *
 * Same contract as Baileys' own `useMultiFileAuthState`, but rows in a
 * `wa_auth` table instead of files, AES-GCM encrypted (see `crypto.ts`) so
 * session material — which grants full account access — is never stored
 * readable.
 *
 * Only Baileys *types* are imported here (erased at compile time, so they add
 * no runtime dependency); the few Baileys runtime values this module needs
 * (`BufferJSON`, `initAuthCreds`, the app-state-sync-key constructor) are
 * passed in by the caller, which already holds them from the dynamic import
 * in `baileys.ts` — see that module for why the import is dynamic.
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

/**
 * Sessions share the `wa_auth` table, namespaced by row-id prefix. The
 * "default" session uses UNPREFIXED ids — exactly a single-session layout —
 * so an existing default session needs no migration when multi-session
 * support is introduced.
 */
export async function useTursoAuthState(
  db: Client,
  secret: string,
  sessionId: string,
  runtime: AuthStateRuntime,
): Promise<TursoAuthStateResult> {
  await ensureAuthSchema(db);

  // "s:" marker prefix cannot collide with Baileys ids (creds, pre-key-...,
  // session-..., app-state-sync-...), so legacy default rows stay unambiguous.
  const rowId = (id: string) => (sessionId === "default" ? id : `s:${sessionId}/${id}`);

  async function read(id: string): Promise<unknown | null> {
    const result = await db.execute({
      sql: "SELECT value FROM wa_auth WHERE id = ?",
      args: [rowId(id)],
    });
    const row = result.rows[0];
    if (!row) return null;
    return JSON.parse(decrypt(row.value as string, secret), runtime.bufferJSON.reviver);
  }

  async function write(id: string, value: unknown): Promise<void> {
    const payload = encrypt(JSON.stringify(value, runtime.bufferJSON.replacer), secret);
    await db.execute({
      sql: "INSERT OR REPLACE INTO wa_auth (id, value) VALUES (?, ?)",
      args: [rowId(id), payload],
    });
  }

  async function remove(id: string): Promise<void> {
    await db.execute({ sql: "DELETE FROM wa_auth WHERE id = ?", args: [rowId(id)] });
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
    clear: async () => {
      // Scoped to THIS session — never nuke a sibling number's pairing.
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
