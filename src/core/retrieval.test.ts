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

describe("VectorStore chunking modes", () => {
  const DOC = "# Guide\n\nIntro line.\n\n## Hours\n\nSupport hours are 9-5.\n";

  function setup(files: Record<string, string> = { "base/info.md": DOC }) {
    const dir = mkdtempSync(join(tmpdir(), "chatter-chunking-"));
    const knowledgeDir = join(dir, "knowledge");
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(join(knowledgeDir, rel, ".."), { recursive: true });
      writeFileSync(join(knowledgeDir, rel), text);
    }
    return { dir, knowledgeDir };
  }

  function recordingEmbedder() {
    const inputs: string[] = [];
    const embed: Embedder = async (input) => {
      inputs.push(...input);
      return input.map(() => [1, 0]);
    };
    return { embed, inputs };
  }

  async function count(db: LibsqlClient, table: string) {
    const res = await db.execute(`SELECT COUNT(*) as n FROM ${table}`);
    return Number(res.rows[0].n);
  }

  test("'lines' (default) keeps raw ids, sources and embedder inputs", async () => {
    const { dir, knowledgeDir } = setup();
    try {
      const db = createClient({ url: "file::memory:", authToken: "" });
      const { embed, inputs } = recordingEmbedder();
      await new VectorStore(embed, { databaseClient: db, knowledgeDir, chunking: "lines" }).build();

      const source = join(knowledgeDir, "base", "info.md");
      const text = DOC.trim();
      const hash = new Bun.CryptoHasher("sha256").update(`base|${source}|${text}`).digest("hex");
      const rows = (await db.execute("SELECT id, source, text FROM chunks")).rows;
      expect<unknown>(rows.map((r) => ({ ...r }))).toEqual([{ id: hash, source, text }]);
      expect(inputs).toEqual([text]);
      const cols = (await db.execute("PRAGMA table_info(chunks)")).rows.map((r) => r.name);
      expect(cols).toEqual(["id", "bucket", "source", "text"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("'sections' stores section, position and a relative source; embeds with a context line", async () => {
    const { dir, knowledgeDir } = setup({
      "base/info.md": DOC,
      "public/notes.md": "Preamble before any heading.\n",
    });
    try {
      const db = createClient({ url: "file::memory:", authToken: "" });
      const { embed, inputs } = recordingEmbedder();
      const store = new VectorStore(embed, {
        databaseClient: db,
        knowledgeDir,
        chunking: "sections",
      });
      await store.build();

      const rows = (
        await db.execute(
          "SELECT source, text, section, position FROM chunks ORDER BY source, position",
        )
      ).rows.map((r) => ({ ...r }));
      expect<unknown>(rows).toEqual([
        { source: "base/info.md", text: "# Guide\n\nIntro line.", section: "Guide", position: 0 },
        {
          source: "base/info.md",
          text: "## Hours\n\nSupport hours are 9-5.",
          section: "Guide > Hours",
          position: 1,
        },
        {
          source: "public/notes.md",
          text: "Preamble before any heading.",
          section: "",
          position: 0,
        },
      ]);
      expect([...inputs].sort()).toEqual(
        [
          "base/info.md > Guide\n\n# Guide\n\nIntro line.",
          "base/info.md > Guide > Hours\n\n## Hours\n\nSupport hours are 9-5.",
          "public/notes.md\n\nPreamble before any heading.",
        ].sort(),
      );
      expect(await store.query("hours", 5, ["base"])).toContain(
        "## Hours\n\nSupport hours are 9-5.",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("'sections' adds the columns to a table created by an earlier release; a second build is a no-op", async () => {
    const { dir, knowledgeDir } = setup();
    try {
      const db = createClient({ url: "file::memory:", authToken: "" });
      await db.execute(
        "CREATE TABLE chunks (id TEXT PRIMARY KEY, bucket TEXT NOT NULL, source TEXT NOT NULL, text TEXT NOT NULL)",
      );
      const messages: string[] = [];
      const logger = {
        debug() {},
        warn() {},
        error() {},
        info: (m: string) => void messages.push(m),
      };
      const { embed, inputs } = recordingEmbedder();
      const store = new VectorStore(embed, {
        databaseClient: db,
        knowledgeDir,
        chunking: "sections",
        logger,
      });

      await store.build();
      const cols = (await db.execute("PRAGMA table_info(chunks)")).rows.map((r) => r.name);
      expect(cols).toEqual(["id", "bucket", "source", "text", "section", "position"]);
      expect(messages).toContain("Chunking mode: sections");

      const embedded = inputs.length;
      await store.build();
      expect(inputs.length).toBe(embedded);
      expect(messages.some((m) => m.includes("No new chunks to embed"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("identical paragraphs under different headings get distinct ids", async () => {
    const { dir, knowledgeDir } = setup({ "base/a.md": "# A\nSame.\n\n# B\nSame.\n" });
    try {
      const db = createClient({ url: "file::memory:", authToken: "" });
      const { embed } = recordingEmbedder();
      await new VectorStore(embed, {
        databaseClient: db,
        knowledgeDir,
        chunking: "sections",
      }).build();
      expect(await count(db, "chunks")).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("switching 'lines' to 'sections' and back re-embeds once and leaves no orphans", async () => {
    const { dir, knowledgeDir } = setup();
    try {
      const db = createClient({ url: "file::memory:", authToken: "" });
      const { embed, inputs } = recordingEmbedder();
      const make = (chunking: "lines" | "sections") =>
        new VectorStore(embed, { databaseClient: db, knowledgeDir, chunking });

      await make("lines").build();
      expect(inputs.length).toBe(1);

      await make("sections").build();
      expect(inputs.length).toBe(3);
      expect(await count(db, "chunks")).toBe(2);
      expect(await count(db, "embeddings")).toBe(2);
      const unset = (await db.execute("SELECT COUNT(*) as n FROM chunks WHERE section IS NULL"))
        .rows[0].n;
      expect(Number(unset)).toBe(0);

      await make("lines").build();
      expect(inputs.length).toBe(4);
      expect(await count(db, "chunks")).toBe(1);
      expect(await count(db, "embeddings")).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("VectorStore.queryChunks", () => {
  const DOC = "# Guide\n\nIntro line.\n\n## Hours\n\nSupport hours are 9-5.\n";

  // Texts mentioning hours embed along [1,0], everything else along [0,1].
  const embedder = (calls: string[][] = []): Embedder => {
    return async (input) => {
      calls.push(input);
      return input.map((t) => (/hours/i.test(t) ? [1, 0] : [0, 1]));
    };
  };

  function setup(files: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), "chatter-querychunks-"));
    const knowledgeDir = join(dir, "knowledge");
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(join(knowledgeDir, rel, ".."), { recursive: true });
      writeFileSync(join(knowledgeDir, rel), text);
    }
    return { dir, knowledgeDir };
  }

  test("returns text, bucket, relative source, section trail and score, best first", async () => {
    const { dir, knowledgeDir } = setup({ "base/info.md": DOC });
    try {
      const db = createClient({ url: "file::memory:", authToken: "" });
      const store = new VectorStore(embedder(), {
        databaseClient: db,
        knowledgeDir,
        chunking: "sections",
      });
      await store.build();

      const got = await store.queryChunks("opening hours", 5, ["base"]);
      expect(got.length).toBe(2);
      expect(got[0].text).toContain("Support hours are 9-5.");
      expect(got[0].text).not.toContain("info.md");
      expect(got[0].bucket).toBe("base");
      expect(got[0].source).toBe("base/info.md");
      expect(got[0].section).toEqual(["Guide", "Hours"]);
      expect(got[0].score).toBeCloseTo(1);
      expect(got[1].score).toBeCloseTo(0);
      expect(got[0].score).toBeGreaterThan(got[1].score);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("never returns a row from a bucket that was not asked for", async () => {
    const { dir, knowledgeDir } = setup({
      "base/a.md": "# A\n\nHours in base.\n",
      "private/b.md": "# B\n\nHours in private.\n",
    });
    try {
      const db = createClient({ url: "file::memory:", authToken: "" });
      const store = new VectorStore(embedder(), { databaseClient: db, knowledgeDir });
      await store.build();

      const got = await store.queryChunks("hours", 10, ["base"]);
      expect(got.length).toBe(1);
      expect(got.every((c) => c.bucket === "base")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("query is exactly queryChunks mapped to text", async () => {
    const { dir, knowledgeDir } = setup({ "base/info.md": DOC });
    try {
      const db = createClient({ url: "file::memory:", authToken: "" });
      const store = new VectorStore(embedder(), {
        databaseClient: db,
        knowledgeDir,
        chunking: "sections",
      });
      await store.build();

      for (const k of [1, 2, 5]) {
        const chunks = await store.queryChunks("hours", k, ["base"]);
        expect(await store.query("hours", k, ["base"])).toEqual(chunks.map((c) => c.text));
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rows ingested in 'lines' mode come back with an empty section", async () => {
    const { dir, knowledgeDir } = setup({ "base/info.md": DOC });
    try {
      const db = createClient({ url: "file::memory:", authToken: "" });
      const store = new VectorStore(embedder(), { databaseClient: db, knowledgeDir });
      await store.build();

      const got = await store.queryChunks("hours", 5, ["base"]);
      expect(got.length).toBe(1);
      expect(got[0].section).toEqual([]);
      expect(got[0].source).toContain("info.md");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an empty bucket list returns nothing without calling the embedder", async () => {
    const calls: string[][] = [];
    const db = createClient({ url: "file::memory:", authToken: "" });
    const store = new VectorStore(embedder(calls), { databaseClient: db });

    expect(await store.queryChunks("hours", 5, [])).toEqual([]);
    expect(calls).toEqual([]);
  });
});
