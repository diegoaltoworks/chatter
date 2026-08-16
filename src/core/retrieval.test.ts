/**
 * Vector store connection tests
 *
 * Uses a faked libsql client and OpenAI client so the connection wiring can be
 * asserted without touching Turso or OpenAI.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, type Client as LibsqlClient } from "@libsql/client";
import type OpenAI from "openai";
import type { ServerDependencies } from "../types";
import {
  createOpenAIEmbedder,
  type Embedder,
  openLibsqlClient,
  VectorStore,
  wrapMissingLibsqlError,
} from "./retrieval";

interface ExecuteCall {
  sql: string;
  args: unknown;
}

function createFakeDb() {
  const calls: ExecuteCall[] = [];

  const db = {
    execute: async (stmt: string | { sql: string; args?: unknown }) => {
      const sql = typeof stmt === "string" ? stmt : stmt.sql;
      const args = typeof stmt === "string" ? undefined : stmt.args;
      calls.push({ sql, args });
      return { rows: [{ id: "chunk-1", text: "injected context", embedding: "[1,0]" }] };
    },
  } as unknown as LibsqlClient;

  return { db, calls };
}

function fakeEmbedder(embedding: number[]): Embedder {
  return async (input) => input.map(() => embedding);
}

describe("VectorStore connection", () => {
  test("exposes the injected client instead of opening a second connection", () => {
    const { db } = createFakeDb();

    const store = new VectorStore(fakeEmbedder([1, 0]), { databaseClient: db });

    expect(store.db).toBe(db);
  });

  test("runs queries against the injected client", async () => {
    const { db, calls } = createFakeDb();
    const store = new VectorStore(fakeEmbedder([1, 0]), { databaseClient: db });

    const results = await store.query("a question", 3, ["base"]);

    expect(results).toEqual(["injected context"]);
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain("FROM chunks c");
    expect(calls[0].args).toEqual(["base"]);
  });

  test("retrieves nothing for an empty bucket list, without embedding the query", async () => {
    const { db, calls } = createFakeDb();
    const embedded: string[] = [];
    const embed: Embedder = async (input) => {
      embedded.push(...input);
      return input.map(() => [1, 0]);
    };
    const store = new VectorStore(embed, { databaseClient: db });

    // A caller that scoped retrieval down to nothing gets nothing - not an
    // `IN ()` syntax error, and not a paid embedding call.
    expect(await store.query("a question", 3, [])).toEqual([]);
    expect(calls).toEqual([]);
    expect(embedded).toEqual([]);
  });

  test("satisfies the ServerDependencies db handle from the store's own client", () => {
    const { db } = createFakeDb();
    const client = {} as ServerDependencies["client"];
    const store = new VectorStore(fakeEmbedder([1, 0]), {
      databaseClient: db,
      knowledgeDir: "./knowledge",
    });

    // Locks the contract createServer relies on: the handle it publishes is the
    // store's client, so consumers of deps.db reuse the one open connection.
    const deps: Pick<ServerDependencies, "client" | "store" | "db"> = {
      client,
      store,
      db: store.db,
    };

    expect(deps.db).toBe(db);
  });

  test("createOpenAIEmbedder adapts an OpenAI client's embeddings.create to the Embedder shape", async () => {
    const calls: { model: string; input: string[] }[] = [];
    const openai = {
      embeddings: {
        create: async ({ model, input }: { model: string; input: string[] }) => {
          calls.push({ model, input });
          return { data: input.map((_, i) => ({ embedding: [i, i] })) };
        },
      },
    } as unknown as OpenAI;

    const embed = createOpenAIEmbedder(openai);
    const vectors = await embed(["a", "b"]);

    expect(vectors).toEqual([
      [0, 0],
      [1, 1],
    ]);
    expect(calls).toEqual([{ model: "text-embedding-3-large", input: ["a", "b"] }]);
  });

  test("build() keeps the connection alive for a subsequent query() against a real local database", async () => {
    // Regression test: `build()` used to upsert chunks/embeddings through
    // `this.db.transaction("write")`, which hands the driver's pooled
    // connection to the transaction handle and lazily opens a *new* one for
    // the client's next call. Against a real Turso database that reconnects
    // to the same data, so nothing looked wrong — but against a local
    // `:memory:` database (the pattern docs/tests use to avoid a real
    // Turso dependency) a fresh connection is a fresh, empty database, so
    // every read after `build()` 404s on its own tables. Only reproducible
    // with the real @libsql/client local driver, not the faked one above.
    const dir = mkdtempSync(join(tmpdir(), "chatter-retrieval-memory-"));
    const knowledgeDir = join(dir, "knowledge");
    mkdirSync(join(knowledgeDir, "base"), { recursive: true });
    writeFileSync(join(knowledgeDir, "base", "info.md"), "# Info\nSupport hours are 9-5.");

    try {
      const db = createClient({ url: "file::memory:", authToken: "" });
      const store = new VectorStore(fakeEmbedder([1, 0]), { databaseClient: db, knowledgeDir });

      await store.build();
      const results = await store.query("support hours", 3, ["base"]);

      expect(results).toEqual(["# Info\nSupport hours are 9-5."]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("build() refuses to run and preserves existing chunks when the knowledge dir resolves to zero documents", async () => {
    // Root cause of a real incident: a knowledgeDir that resolves to zero
    // documents (wrong cwd, an emptied folder) made every existing chunk
    // read as stale, and cleanupStaleChunks deleted the entire knowledge
    // base with no error anywhere in the process. build() must fail loudly
    // before it ever reaches cleanup.
    const dir = mkdtempSync(join(tmpdir(), "chatter-retrieval-zero-docs-"));
    const knowledgeDir = join(dir, "knowledge");
    mkdirSync(join(knowledgeDir, "base"), { recursive: true });
    writeFileSync(join(knowledgeDir, "base", "info.md"), "# Info\nSupport hours are 9-5.");

    try {
      const db = createClient({ url: "file::memory:", authToken: "" });
      const store = new VectorStore(fakeEmbedder([1, 0]), { databaseClient: db, knowledgeDir });
      await store.build();
      expect(await store.query("support hours", 3, ["base"])).toEqual([
        "# Info\nSupport hours are 9-5.",
      ]);

      const emptyDir = join(dir, "empty");
      mkdirSync(emptyDir, { recursive: true });
      const brokenStore = new VectorStore(fakeEmbedder([1, 0]), {
        databaseClient: db,
        knowledgeDir: emptyDir,
      });

      await expect(brokenStore.build()).rejects.toThrow(/loaded 0 knowledge documents/);

      // The original content must still be there and still queryable.
      expect(await store.query("support hours", 3, ["base"])).toEqual([
        "# Info\nSupport hours are 9-5.",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("cleanupStaleChunks deletes embeddings for chunks removed from the knowledge dir", async () => {
    // Regression test for the false "cascade delete" assumption: there is no
    // FK between chunks and embeddings, so a stale chunk's embedding row was
    // left behind unless deleted explicitly.
    const dir = mkdtempSync(join(tmpdir(), "chatter-retrieval-stale-embeddings-"));
    const knowledgeDir = join(dir, "knowledge");
    mkdirSync(join(knowledgeDir, "base"), { recursive: true });
    writeFileSync(join(knowledgeDir, "base", "info.md"), "# Info\nSupport hours are 9-5.");

    try {
      const db = createClient({ url: "file::memory:", authToken: "" });
      const store = new VectorStore(fakeEmbedder([1, 0]), { databaseClient: db, knowledgeDir });
      await store.build();

      const before = await db.execute("SELECT id FROM embeddings");
      expect(before.rows.length).toBeGreaterThan(0);

      // Overwrite the source file's content so the old chunk id (derived
      // from a hash of the text) no longer appears among current ids, then
      // rebuild - the old chunk and its embedding become stale.
      writeFileSync(join(knowledgeDir, "base", "info.md"), "# Info\nNew content entirely.");
      await store.build();

      const after = await db.execute("SELECT id FROM embeddings");
      const staleIds = before.rows.map((r) => String(r.id));
      const survivingStaleIds = after.rows
        .map((r) => String(r.id))
        .filter((id) => staleIds.includes(id));

      expect(survivingStaleIds).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("wrapMissingLibsqlError", () => {
  test("names the package, an install command, and the config.retriever escape hatch, and preserves the cause", () => {
    const cause = new Error("Cannot find package '@libsql/client'");

    const wrapped = wrapMissingLibsqlError(cause);

    expect(wrapped.message).toContain("@libsql/client");
    expect(wrapped.message).toContain("bun add @libsql/client");
    expect(wrapped.message).toContain("config.retriever");
    expect(wrapped.cause).toBe(cause);
  });
});

describe("openLibsqlClient", () => {
  // The optional peer dependency is installed in this repo's devDependencies
  // (for types and tests), so this proves the happy path resolves; the
  // missing-package path is covered by wrapMissingLibsqlError above without
  // needing to simulate an actually-uninstalled package.
  test("opens a client against the given credentials", async () => {
    const db = await openLibsqlClient({ url: "file::memory:", authToken: "" });

    expect(typeof db.execute).toBe("function");
  });
});
