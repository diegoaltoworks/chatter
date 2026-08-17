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

/** Records every statement a store sends, without changing what the client does. */
function trackSql(db: LibsqlClient) {
  const sql: string[] = [];
  const client = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "execute") {
        return (stmt: string | { sql: string }) => {
          sql.push(typeof stmt === "string" ? stmt : stmt.sql);
          return target.execute(stmt as Parameters<LibsqlClient["execute"]>[0]);
        };
      }
      if (prop === "batch") {
        return (stmts: Array<string | { sql: string }>, mode?: unknown) => {
          for (const stmt of stmts) sql.push(typeof stmt === "string" ? stmt : stmt.sql);
          return target.batch(
            stmts as Parameters<LibsqlClient["batch"]>[0],
            mode as Parameters<LibsqlClient["batch"]>[1],
          );
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { client, sql };
}

/** Collects log output so a test can assert on it, and keeps test output quiet. */
function collectingLogger() {
  const lines: string[] = [];
  const record =
    (level: string) =>
    (...args: unknown[]) => {
      lines.push(`${level} ${args.join(" ")}`);
    };
  return {
    lines,
    logger: {
      debug: record("debug"),
      info: record("info"),
      warn: record("warn"),
      error: record("error"),
    },
  };
}

function writeKnowledge(root: string, name: string, text: string) {
  const dir = join(root, name);
  mkdirSync(join(dir, "base"), { recursive: true });
  writeFileSync(join(dir, "base", "info.md"), text);
  return dir;
}

async function countRows(db: LibsqlClient, table: string) {
  const res = await db.execute(`SELECT COUNT(*) as count FROM ${table}`);
  return Number(res.rows[0]?.count ?? 0);
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

  test("concurrent builds against one database leave the same chunks a single build would", async () => {
    // Two instances booting at the same time against one production database
    // (a rolling deploy, a manual deploy racing an automated one) must never
    // end up with fewer chunks than either boot alone would have written.
    const dir = mkdtempSync(join(tmpdir(), "chatter-retrieval-concurrent-"));
    const knowledgeDir = writeKnowledge(dir, "knowledge", "# Info\nSupport hours are 9-5.");

    try {
      const solo = createClient({ url: "file::memory:", authToken: "" });
      await new VectorStore(fakeEmbedder([1, 0]), {
        databaseClient: solo,
        knowledgeDir,
        logger: collectingLogger().logger,
      }).build();
      const soloChunks = await countRows(solo, "chunks");
      const soloEmbeddings = await countRows(solo, "embeddings");
      expect(soloChunks).toBeGreaterThan(0);

      const shared = createClient({ url: "file::memory:", authToken: "" });
      const options = { databaseClient: shared, knowledgeDir, logger: collectingLogger().logger };
      await Promise.all([
        new VectorStore(fakeEmbedder([1, 0]), { ...options, instanceId: "a" }).build(),
        new VectorStore(fakeEmbedder([1, 0]), { ...options, instanceId: "b" }).build(),
      ]);

      expect(await countRows(shared, "chunks")).toBe(soloChunks);
      expect(await countRows(shared, "embeddings")).toBe(soloEmbeddings);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a build that starts while another is in flight skips its destructive delete phase", async () => {
    // The second knowledge-base wipe: every boot saw a non-zero document
    // count (so the zero-docs guard could not catch it), but each boot's
    // cleanup pass diffed against a database another boot was still writing
    // and deleted its chunks as stale. The second builder must take no
    // destructive action at all while the first holds the lock.
    const dir = mkdtempSync(join(tmpdir(), "chatter-retrieval-inflight-"));
    const firstDir = writeKnowledge(dir, "first", "# Info\nFirst revision content.");
    const secondDir = writeKnowledge(dir, "second", "# Info\nA different revision entirely.");

    try {
      const db = createClient({ url: "file::memory:", authToken: "" });

      // Hold the first build open inside its embedding step: by then its
      // chunks are written and its embeddings are not, the exact window the
      // racing boot used to delete.
      let firstIsEmbedding: () => void = () => {};
      const embedding = new Promise<void>((resolve) => {
        firstIsEmbedding = resolve;
      });
      let releaseFirst: () => void = () => {};
      const held = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const gatedEmbed: Embedder = async (input) => {
        firstIsEmbedding();
        await held;
        return input.map(() => [1, 0]);
      };

      const first = new VectorStore(gatedEmbed, {
        databaseClient: db,
        knowledgeDir: firstDir,
        instanceId: "first",
        logger: collectingLogger().logger,
      });
      const tracked = trackSql(db);
      const secondLog = collectingLogger();
      const second = new VectorStore(fakeEmbedder([1, 0]), {
        databaseClient: tracked.client,
        knowledgeDir: secondDir,
        instanceId: "second",
        logger: secondLog.logger,
      });

      const firstBuild = first.build();
      await embedding;

      await second.build();

      expect(tracked.sql.filter((s) => /DELETE FROM chunks/i.test(s))).toEqual([]);
      expect(
        secondLog.lines.some((l) => l.startsWith("warn") && l.includes("Another instance")),
      ).toBe(true);

      releaseFirst();
      await firstBuild;

      // The first instance's knowledge survived intact and is queryable.
      expect(await first.query("content", 3, ["base"])).toEqual([
        "# Info\nFirst revision content.",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a later build still cleans up stale chunks once the lock is free", async () => {
    // The lock must not turn cleanup off permanently: a boot that actually
    // holds it still prunes what the knowledge dir no longer contains.
    const dir = mkdtempSync(join(tmpdir(), "chatter-retrieval-lock-release-"));
    const knowledgeDir = writeKnowledge(dir, "knowledge", "# Info\nSupport hours are 9-5.");

    try {
      const db = createClient({ url: "file::memory:", authToken: "" });
      const logger = collectingLogger().logger;
      await new VectorStore(fakeEmbedder([1, 0]), {
        databaseClient: db,
        knowledgeDir,
        instanceId: "first",
        logger,
      }).build();
      const firstIds = (await db.execute("SELECT id FROM chunks")).rows.map((r) => String(r.id));

      writeFileSync(join(knowledgeDir, "base", "info.md"), "# Info\nNew content entirely.");
      const second = new VectorStore(fakeEmbedder([1, 0]), {
        databaseClient: db,
        knowledgeDir,
        instanceId: "second",
        logger,
      });
      await second.build();

      const after = (await db.execute("SELECT id FROM chunks")).rows.map((r) => String(r.id));
      expect(after.filter((id) => firstIds.includes(id))).toEqual([]);
      expect(after.length).toBeGreaterThan(0);
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
