import { describe, expect, test } from "bun:test";
import { createClient } from "@libsql/client";
import { BufferJSON, initAuthCreds, proto } from "@whiskeysockets/baileys";
import { type AuthStateRuntime, useAuthState, useTursoAuthState, type WaAuthKV } from "./authState";
import { decrypt } from "./crypto";

/** An in-memory `WaAuthKV` — proves `useAuthState` works against any store, not just the Turso default. */
function fakeAuthKV(): WaAuthKV & { rows: Map<string, string> } {
  const rows = new Map<string, string>();
  return {
    rows,
    async read(id) {
      return rows.has(id) ? (rows.get(id) as string) : null;
    },
    async write(id, value) {
      rows.set(id, value);
    },
    async remove(id) {
      rows.delete(id);
    },
    async clear(sessionId) {
      const prefix = sessionId === "default" ? undefined : `s:${sessionId}/`;
      for (const id of [...rows.keys()]) {
        const isDefaultRow = !id.startsWith("s:");
        if (prefix ? id.startsWith(prefix) : isDefaultRow) rows.delete(id);
      }
    },
  };
}

function memoryClient() {
  return createClient({ url: ":memory:" });
}

const runtime: AuthStateRuntime = {
  bufferJSON: BufferJSON,
  initAuthCreds,
  appStateSyncKeyFromObject: (value) => proto.Message.AppStateSyncKeyData.fromObject(value),
};

describe("useTursoAuthState", () => {
  test("a fresh session starts unregistered with generated creds", async () => {
    const { state } = await useTursoAuthState(memoryClient(), "secret", "default", runtime);

    expect(state.creds.registered).toBe(false);
    expect(state.creds.noiseKey).toBeDefined();
  });

  test("saveCreds persists creds; a later load recovers the same identity", async () => {
    const db = memoryClient();
    const first = await useTursoAuthState(db, "secret", "default", runtime);
    first.state.creds.registered = true;
    await first.saveCreds();

    const second = await useTursoAuthState(db, "secret", "default", runtime);

    expect(second.state.creds.registered).toBe(true);
  });

  test("stored creds are ciphertext at rest, never the plaintext session material", async () => {
    const db = memoryClient();
    const { state, saveCreds } = await useTursoAuthState(db, "secret", "default", runtime);
    state.creds.registered = true;
    await saveCreds();

    const row = await db.execute({
      sql: "SELECT value FROM wa_auth WHERE id = ?",
      args: ["creds"],
    });
    expect(row.rows).toHaveLength(1);
    const storedValue = String(row.rows[0]?.value);

    // A plaintext or weakly-encoded leak would contain this field name
    // directly; only decrypting with the right secret should reveal it.
    expect(storedValue).not.toContain("noiseKey");
    expect(await decrypt(storedValue, "secret")).toContain("noiseKey");

    // Same plaintext saved twice must not produce identical ciphertext
    // (rules out a deterministic, IV-less encoding).
    await saveCreds();
    const secondRow = await db.execute({
      sql: "SELECT value FROM wa_auth WHERE id = ?",
      args: ["creds"],
    });
    expect(String(secondRow.rows[0]?.value)).not.toBe(storedValue);
  });

  test("wrong secret fails to decrypt stored creds", async () => {
    const db = memoryClient();
    const first = await useTursoAuthState(db, "right-secret", "default", runtime);
    first.state.creds.registered = true;
    await first.saveCreds();

    await expect(useTursoAuthState(db, "wrong-secret", "default", runtime)).rejects.toThrow();
  });

  test("signal keys round-trip through set/get", async () => {
    const db = memoryClient();
    const { state } = await useTursoAuthState(db, "secret", "default", runtime);

    await state.keys.set({
      "pre-key": { "1": { public: Buffer.from("pub"), private: Buffer.from("priv") } },
    });

    const fetched = await state.keys.get("pre-key", ["1", "2"]);

    expect(fetched["1"]).toBeDefined();
    expect(fetched["2"]).toBeUndefined();
  });

  test("a null value in keys.set deletes the entry", async () => {
    const db = memoryClient();
    const { state } = await useTursoAuthState(db, "secret", "default", runtime);

    await state.keys.set({
      "pre-key": { "1": { public: Buffer.from("pub"), private: Buffer.from("priv") } },
    });
    await state.keys.set({ "pre-key": { "1": null } });

    const fetched = await state.keys.get("pre-key", ["1"]);
    expect(fetched["1"]).toBeUndefined();
  });

  test("the default session's rows are unprefixed (zero-migration layout)", async () => {
    const db = memoryClient();
    const { state, saveCreds } = await useTursoAuthState(db, "secret", "default", runtime);
    state.creds.registered = true;
    await saveCreds();

    const row = await db.execute({ sql: "SELECT id FROM wa_auth WHERE id = ?", args: ["creds"] });
    expect(row.rows).toHaveLength(1);
  });

  test("a named session's rows are namespaced and independent of default", async () => {
    const db = memoryClient();
    const defaultSession = await useTursoAuthState(db, "secret", "default", runtime);
    defaultSession.state.creds.registered = true;
    await defaultSession.saveCreds();

    const named = await useTursoAuthState(db, "secret", "second-number", runtime);
    expect(named.state.creds.registered).toBe(false);

    named.state.creds.registered = true;
    await named.saveCreds();

    // Reloading "default" must still see only its own creds.
    const reloadedDefault = await useTursoAuthState(db, "secret", "default", runtime);
    expect(reloadedDefault.state.creds.registered).toBe(true);
  });

  test("clear() on the default session wipes only unprefixed rows", async () => {
    const db = memoryClient();
    const defaultSession = await useTursoAuthState(db, "secret", "default", runtime);
    defaultSession.state.creds.registered = true;
    await defaultSession.saveCreds();

    const named = await useTursoAuthState(db, "secret", "second-number", runtime);
    named.state.creds.registered = true;
    await named.saveCreds();

    await defaultSession.clear();

    const reloadedDefault = await useTursoAuthState(db, "secret", "default", runtime);
    const reloadedNamed = await useTursoAuthState(db, "secret", "second-number", runtime);
    expect(reloadedDefault.state.creds.registered).toBe(false);
    expect(reloadedNamed.state.creds.registered).toBe(true);
  });

  test("clear() on a named session never touches a sibling's pairing", async () => {
    const db = memoryClient();
    const named = await useTursoAuthState(db, "secret", "second-number", runtime);
    named.state.creds.registered = true;
    await named.saveCreds();

    const defaultSession = await useTursoAuthState(db, "secret", "default", runtime);
    defaultSession.state.creds.registered = true;
    await defaultSession.saveCreds();

    await named.clear();

    const reloadedDefault = await useTursoAuthState(db, "secret", "default", runtime);
    const reloadedNamed = await useTursoAuthState(db, "secret", "second-number", runtime);
    expect(reloadedDefault.state.creds.registered).toBe(true);
    expect(reloadedNamed.state.creds.registered).toBe(false);
  });
});

describe("useAuthState with an injected WaAuthKV", () => {
  test("persists and reloads creds through a non-Turso store", async () => {
    const store = fakeAuthKV();
    const first = await useAuthState(store, "secret", "default", runtime);
    first.state.creds.registered = true;
    await first.saveCreds();

    const second = await useAuthState(store, "secret", "default", runtime);

    expect(second.state.creds.registered).toBe(true);
  });

  test("the store only ever sees ciphertext, never the plaintext session material", async () => {
    const store = fakeAuthKV();
    const { state, saveCreds } = await useAuthState(store, "secret", "default", runtime);
    state.creds.registered = true;
    await saveCreds();

    const stored = store.rows.get("creds") as string;
    expect(stored).not.toContain("noiseKey");
    expect(await decrypt(stored, "secret")).toContain("noiseKey");
  });

  test("clear() is scoped to the session, mirroring the Turso-backed store", async () => {
    const store = fakeAuthKV();
    const defaultSession = await useAuthState(store, "secret", "default", runtime);
    defaultSession.state.creds.registered = true;
    await defaultSession.saveCreds();

    const named = await useAuthState(store, "secret", "second-number", runtime);
    named.state.creds.registered = true;
    await named.saveCreds();

    await named.clear();

    const reloadedDefault = await useAuthState(store, "secret", "default", runtime);
    const reloadedNamed = await useAuthState(store, "secret", "second-number", runtime);
    expect(reloadedDefault.state.creds.registered).toBe(true);
    expect(reloadedNamed.state.creds.registered).toBe(false);
  });
});
