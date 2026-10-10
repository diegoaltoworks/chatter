import { relative, sep } from "node:path";
import type { Client as LibsqlClient } from "@libsql/client";
import type OpenAI from "openai";
import {
  BUILD_LOCK_KEY,
  BUILD_LOCK_STALE_MS,
  type BuildLock,
  createTursoBuildLock,
} from "./buildLock";
import { chunkSections } from "./chunking";
import { type Bucket, loadKnowledge } from "./loaders";
import { createConsoleLogger, type Logger } from "./logger";

const EMB_MODEL = "text-embedding-3-large";

/** Default knowledge directory when a caller's `config.knowledgeDir` is unset. */
export const DEFAULT_KNOWLEDGE_DIR = "./config/knowledge";

/**
 * The retrieval seam `prepareChat` runs against: given a query, return up to
 * `k` chunks drawn only from `allowedBuckets`. {@link VectorStore} is the
 * shipped implementation (brute-force cosine similarity over embeddings in
 * Turso) - this interface is the scaling path for a host that outgrows it
 * (pgvector, sqlite-vec, Qdrant, a managed vector database) without touching
 * `prepareChat`, `ServerDependencies`, or any chat surface. See
 * [patterns/adding-a-retriever.md](../../docs/patterns/adding-a-retriever.md).
 */
export interface Retriever {
  /** Retrieve up to `k` chunks across `allowedBuckets` for `query`, most relevant first. */
  query(query: string, k: number, allowedBuckets: string[]): Promise<string[]>;
  /**
   * Optional record-returning variant of `query`, for a host that needs to
   * know where a passage came from (a search route, citations). `prepareChat`
   * never calls it; implement it only if your own code wants provenance.
   * Same scoping and ordering rules as `query`.
   */
  queryChunks?(query: string, k: number, allowedBuckets: string[]): Promise<RetrievedChunk[]>;
  /**
   * Optional one-time ingest/warm-up step, run once at server startup before
   * the store answers any query. Omit it for a retriever that is always
   * already up to date (a remote index another process maintains).
   */
  build?(): Promise<void>;
}

/** One retrieval result with its provenance. See {@link Retriever.queryChunks}. */
export interface RetrievedChunk {
  /** The chunk text alone, without any embedding context line. */
  text: string;
  bucket: string;
  /** Where the chunk came from; knowledgeDir-relative for rows ingested in `'sections'` mode. */
  source: string;
  /** Heading trail from the H1 down; empty when the row has none (every `'lines'` row). */
  section: string[];
  /** Cosine similarity between the query and the chunk embedding. */
  score: number;
}

/**
 * Embeds a batch of texts into vectors, in input order. Lets
 * {@link VectorStore} stay decoupled from any specific embeddings provider -
 * {@link createOpenAIEmbedder} is the shipped adapter for OpenAI's API.
 */
export type Embedder = (input: string[]) => Promise<number[][]>;

/**
 * Wraps an OpenAI client's `embeddings.create` as an {@link Embedder}, pinned
 * to the same model `VectorStore` has always used - the model isn't a
 * parameter because `VectorStore` labels every stored row with `EMB_MODEL`
 * and never re-embeds rows written under a different one, so swapping models
 * here without also handling that migration would silently corrupt search
 * quality.
 */
export function createOpenAIEmbedder(client: OpenAI): Embedder {
  return async (input: string[]) => {
    const res = await client.embeddings.create({ model: EMB_MODEL, input });
    return res.data.map((d) => d.embedding as number[]);
  };
}

/** Thrown by `createServer`/`createMCPServer` when neither `config.retriever` nor `config.database` is set. Single-sourced so both surfaces state the same requirement. */
export const DATABASE_CONFIG_REQUIRED_MESSAGE =
  "config.database is required unless config.retriever is set - Chatter's default " +
  "knowledge store (VectorStore) needs a Turso/libsql connection. Set config.database, " +
  "or supply config.retriever to use your own retrieval backend instead.";

/** Wraps a failed dynamic import of the optional `@libsql/client` peer in an actionable message. Exported separately so the message content is unit-testable without simulating a real missing module. */
export function wrapMissingLibsqlError(cause: unknown): Error {
  return new Error(
    "Chatter's default knowledge store needs the optional peer dependency '@libsql/client', " +
      "which is not installed. Install it with `bun add @libsql/client` (or npm/pnpm/yarn), or " +
      "set config.retriever to use your own retrieval backend instead.",
    { cause },
  );
}

/**
 * Opens a libsql client for `database`, the one place `createServer`/
 * `createMCPServer` touch `@libsql/client` at runtime - called lazily, only
 * when a connection is actually needed, so a host running with
 * `config.retriever` and no `config.database` never imports it at all.
 */
export async function openLibsqlClient(database: {
  url: string;
  authToken: string;
}): Promise<LibsqlClient> {
  const mod = await import("@libsql/client").catch((error) => {
    throw wrapMissingLibsqlError(error);
  });
  return mod.createClient({ url: database.url, authToken: database.authToken });
}

function chunk(text: string, max = 900) {
  const out: string[] = [];
  let buf = "";
  for (const line of text.replace(/\r/g, "").split("\n")) {
    if (`${buf}\n${line}`.length > max) {
      out.push(buf.trim());
      buf = line;
    } else buf += `\n${line}`;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

async function sha256(input: string) {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Chunking strategy for {@link VectorStoreOptions.chunking}. */
export type ChunkingMode = "lines" | "sections";

type ChunkRow = {
  id: string;
  bucket: Bucket;
  source: string;
  text: string;
  /** Text sent to the embedder; equals `text` unless a context line is prepended. */
  embedText: string;
  section: string | null;
  position: number | null;
};

/**
 * `VectorStore` always takes an already-open libsql client rather than
 * credentials to open its own - the same rule every other store in this
 * codebase follows (see
 * [patterns/adding-a-store.md](../../docs/patterns/adding-a-store.md)), so
 * `@libsql/client`'s runtime is never imported here: the caller (`createServer`,
 * `createMCPServer`, or your own code) opens the connection and this module
 * only ever sees the resulting value. Reusing one client is also what lets
 * `ServerDependencies.db` and the store share a single connection instead of
 * opening a second one.
 */
export interface VectorStoreOptions {
  /** An existing libsql client this store queries and writes through. */
  databaseClient: LibsqlClient;
  /** Directory of markdown knowledge files. Default: `./config/knowledge` */
  knowledgeDir?: string;
  /**
   * How knowledge files are cut into chunks. `'lines'` (default) keeps the
   * original fixed-size line chunks, so ids and embeddings are unchanged.
   * `'sections'` cuts at Markdown headings (see
   * [chunking.ts](./chunking.ts)), records each chunk's heading trail and
   * position, and embeds it with a `<source> > <heading trail>` context line.
   * Switching modes re-embeds every chunk once on the next build.
   */
  chunking?: ChunkingMode;
  /** Logger for build progress. Default: a console logger writing to stderr. */
  logger?: Logger;
  /**
   * Single-writer lock `build()` holds while it rewrites the knowledge base,
   * so two instances booting against one database cannot delete each other's
   * chunks. Default: a lock table in `databaseClient` (see
   * [buildLock.ts](./buildLock.ts)); supply your own to back it with
   * something else, or a lock that always grants to opt out.
   */
  buildLock?: BuildLock;
  /** Identifies this process while it holds the build lock. Default: a random id per store. */
  instanceId?: string;
  /** How long a held build lock survives with no heartbeat before another instance may take it over. Default: 10 minutes. */
  buildLockStaleMs?: number;
}

export class VectorStore implements Retriever {
  /**
   * The libsql client backing this store - the same instance passed in as
   * `databaseClient`, so callers holding it (e.g. `ServerDependencies.db`)
   * and the store share one connection.
   */
  readonly db: LibsqlClient;
  private knowledgeDir: string;
  private chunking: ChunkingMode;
  private logger: Logger;
  private buildLock: BuildLock;
  private instanceId: string;
  private buildLockStaleMs: number;

  constructor(
    private embed: Embedder,
    options: VectorStoreOptions,
  ) {
    this.db = options.databaseClient;
    this.knowledgeDir = options.knowledgeDir || DEFAULT_KNOWLEDGE_DIR;
    this.chunking = options.chunking ?? "lines";
    this.logger = options.logger ?? createConsoleLogger();
    this.buildLock = options.buildLock ?? createTursoBuildLock(this.db);
    this.instanceId = options.instanceId ?? crypto.randomUUID();
    this.buildLockStaleMs = options.buildLockStaleMs ?? BUILD_LOCK_STALE_MS;
  }

  /**
   * On boot: ingest new chunks and embed only missing ones.
   *
   * The whole ingest runs under a single-writer lock held in the database
   * (see [buildLock.ts](./buildLock.ts)), because the cleanup step deletes
   * every chunk id the current `knowledgeDir` did not produce. Without the
   * lock, a second instance booting mid-build diffs against a database the
   * first one is still writing and deletes its chunks. An instance that
   * cannot take the lock skips its build entirely and serves what the holder
   * has already written, rather than racing it.
   */
  async build() {
    this.logger.info("Building knowledge base...");

    // ensure tables exist (idempotent)
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS chunks (id TEXT PRIMARY KEY, bucket TEXT NOT NULL, source TEXT NOT NULL, text TEXT NOT NULL);
    `);
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS embeddings (id TEXT PRIMARY KEY, model TEXT NOT NULL, embedding BLOB NOT NULL);
    `);
    await this.db.execute("CREATE INDEX IF NOT EXISTS idx_chunks_bucket ON chunks(bucket);");

    if (!(await this.renewBuildLock())) {
      this.logger.warn(
        "Another instance is building the knowledge base against this database - " +
          "skipping this build and using what it has written. Nothing was deleted.",
      );
      return;
    }

    try {
      await this.buildUnderLock();
    } finally {
      await this.buildLock.release(BUILD_LOCK_KEY, this.instanceId);
    }
  }

  /** Acquires the build lock, or refreshes the heartbeat if this store already holds it. */
  private renewBuildLock(): Promise<boolean> {
    return this.buildLock.tryAcquire(
      BUILD_LOCK_KEY,
      this.instanceId,
      Date.now(),
      this.buildLockStaleMs,
    );
  }

  /** The ingest itself. Only ever runs with the build lock held. */
  private async buildUnderLock() {
    const docs = loadKnowledge(this.knowledgeDir);
    this.logger.info(`Loaded ${docs.length} knowledge documents`);

    if (docs.length === 0) {
      const existing = await this.db.execute("SELECT COUNT(*) as count FROM chunks");
      const existingCount = Number(existing.rows[0]?.count ?? 0);
      // Zero documents on a first build (nothing ingested yet) is a normal,
      // empty knowledge base. Zero documents when chunks already exist means
      // knowledgeDir resolved to the wrong place (bad cwd, an emptied
      // folder) - proceeding would read every existing chunk as stale and
      // delete the whole knowledge base with no error anywhere.
      if (existingCount > 0) {
        throw new Error(
          `Refusing to build: loaded 0 knowledge documents from "${this.knowledgeDir}", ` +
            `but ${existingCount} chunks already exist. Proceeding would delete all of them ` +
            "as stale. Check that knowledgeDir resolves to the right path.",
        );
      }
      this.logger.info("No knowledge documents and no existing chunks - nothing to build");
      return;
    }

    this.logger.info(`Chunking mode: ${this.chunking}`);
    if (this.chunking === "sections") await this.ensureSectionColumns();

    const rows: ChunkRow[] = [];
    for (const d of docs) {
      if (this.chunking === "sections") {
        const source = relative(this.knowledgeDir, d.source).split(sep).join("/");
        for (const c of chunkSections(d.text)) {
          const section = c.section.join(" > ");
          const id = await sha256(`${d.bucket}|${source}|${section}|${c.text}`);
          const context = section ? `${source} > ${section}` : source;
          rows.push({
            id,
            bucket: d.bucket,
            source,
            text: c.text,
            embedText: `${context}\n\n${c.text}`,
            section,
            position: c.position,
          });
        }
      } else {
        for (const part of chunk(d.text)) {
          const id = await sha256(`${d.bucket}|${d.source}|${part}`);
          rows.push({
            id,
            bucket: d.bucket,
            source: d.source,
            text: part,
            embedText: part,
            section: null,
            position: null,
          });
        }
      }
    }

    this.logger.info(`Created ${rows.length} chunks from knowledge documents`);

    // Cleanup: remove chunks that no longer exist in markdown files
    await this.cleanupStaleChunks(rows.map((r) => r.id));

    // Upsert chunks. `batch()`, not `transaction()`: an explicit
    // transaction() hands the driver's pooled connection to the returned
    // handle and lazily opens a new one for the client's next call — for a
    // remote Turso database that reconnects to the same data, but for a
    // local/`:memory:` database (docs/tests) it silently opens a second,
    // empty database, and every read after this point 404s on its own
    // tables. `batch()` runs its statements atomically without giving up
    // the connection.
    const UPSERT_BATCH = 500;
    for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
      const batch = rows.slice(i, i + UPSERT_BATCH);
      await this.db.batch(
        batch.map((r) =>
          this.chunking === "sections"
            ? {
                sql: `INSERT INTO chunks(id,bucket,source,text,section,position) VALUES(?,?,?,?,?,?)
                      ON CONFLICT(id) DO NOTHING`,
                args: [r.id, r.bucket, r.source, r.text, r.section, r.position],
              }
            : {
                sql: `INSERT INTO chunks(id,bucket,source,text) VALUES(?,?,?,?)
                      ON CONFLICT(id) DO NOTHING`,
                args: [r.id, r.bucket, r.source, r.text],
              },
        ),
        "write",
      );
    }

    // Find which embeddings are missing
    const ids = rows.map((r) => r.id);
    const missing: string[] = [];
    // chunk query in batches
    for (let i = 0; i < ids.length; i += 500) {
      const batch = ids.slice(i, i + 500);
      const placeholders = batch.map(() => "?").join(",");
      const res = await this.db.execute({
        sql: `SELECT id FROM chunks WHERE id IN (${placeholders})
              EXCEPT SELECT id FROM embeddings`,
        args: batch,
      });
      for (const row of res.rows) missing.push(String(row.id));
    }

    if (missing.length === 0) {
      this.logger.info("No new chunks to embed - knowledge base is up to date");
      return;
    }

    this.logger.info(`Embedding ${missing.length} new/updated chunks with ${EMB_MODEL}...`);

    // Embed missing in batches of N
    const textById = new Map(rows.map((r) => [r.id, r.embedText]));
    const BATCH = 96;
    for (let i = 0; i < missing.length; i += BATCH) {
      const batchIds = missing.slice(i, i + BATCH);
      const inputs = batchIds.map((id) => textById.get(id) || "");
      const vectors = await this.embed(inputs);
      // See the chunks upsert above: batch(), not transaction(), to keep
      // the connection alive for whatever reads this store does next.
      await this.db.batch(
        vectors.map((embedding, idx) => ({
          sql: "INSERT INTO embeddings(id,model,embedding) VALUES(?,?,?)",
          args: [batchIds[idx], EMB_MODEL, JSON.stringify(embedding)],
        })),
        "write",
      );
      // Embedding a large knowledge base can outlast the lock's stale
      // window, so heartbeat between batches: a build that is still making
      // progress keeps the lock instead of looking abandoned.
      if (!(await this.renewBuildLock())) {
        this.logger.warn(
          "Lost the knowledge-base build lock to another instance mid-build - " +
            "remaining chunks may be embedded by that instance instead.",
        );
      }
    }

    this.logger.info(`Successfully embedded ${missing.length} new chunks`);
  }

  /**
   * Adds the nullable `section`/`position` columns to a `chunks` table that
   * every released version created without them. Checked via table_info so it
   * is a no-op once present; only `'sections'` mode ever calls it.
   */
  private async ensureSectionColumns() {
    const info = await this.db.execute("PRAGMA table_info(chunks)");
    const have = new Set(info.rows.map((r) => String(r.name)));
    if (!have.has("section")) await this.db.execute("ALTER TABLE chunks ADD COLUMN section TEXT");
    if (!have.has("position"))
      await this.db.execute("ALTER TABLE chunks ADD COLUMN position INTEGER");
  }

  // Remove chunks from database that no longer exist in markdown files
  private async cleanupStaleChunks(currentIds: string[]) {
    // Get all chunk IDs currently in database
    const result = await this.db.execute("SELECT id FROM chunks");
    const dbIds = result.rows.map((row) => String(row.id));

    // Find IDs that are in database but not in current markdown files
    const currentIdSet = new Set(currentIds);
    const staleIds = dbIds.filter((id) => !currentIdSet.has(id));

    if (staleIds.length === 0) {
      return;
    }

    this.logger.info(`Cleaning up ${staleIds.length} stale chunks...`);

    // Delete stale chunks and their embeddings in batches. There is no FK
    // cascade between the two tables, so both deletes are needed - leaving
    // the embeddings delete out orphans rows that outlive their chunk. The
    // pair runs as one batch() so a chunk is never deleted without its
    // embedding (or vice versa) if the connection drops mid-cleanup.
    const BATCH_SIZE = 500;
    for (let i = 0; i < staleIds.length; i += BATCH_SIZE) {
      const batch = staleIds.slice(i, i + BATCH_SIZE);
      const placeholders = batch.map(() => "?").join(",");

      await this.db.batch(
        [
          { sql: `DELETE FROM chunks WHERE id IN (${placeholders})`, args: batch },
          { sql: `DELETE FROM embeddings WHERE id IN (${placeholders})`, args: batch },
        ],
        "write",
      );
    }

    this.logger.info(`Cleaned up ${staleIds.length} stale chunks and their embeddings`);
  }

  private static cosine(a: number[], b: number[]) {
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }

  /**
   * Retrieve top-k across allowed buckets; compute similarity in app (simple
   * & portable).
   *
   * `allowed` is a bucket-name list rather than the {@link Bucket} union: the
   * `chunks` table constrains nothing, so a deployment that ingests its own
   * buckets can query them (`build` only writes and prunes the three the
   * knowledge loader walks). Names are bound as query parameters, never
   * interpolated. An empty list retrieves nothing, and short-circuits before
   * the embedding call.
   */
  async queryChunks(q: string, k = 6, allowed: string[] = ["base"]): Promise<RetrievedChunk[]> {
    if (allowed.length === 0) return [];

    const [qv] = await this.embed([q]);

    // `c.*` rather than named columns: the `section` column only exists once
    // a build has run in 'sections' mode, and a row without it must still work.
    const placeholders = allowed.map(() => "?").join(",");
    const res = await this.db.execute({
      sql: `SELECT c.*, e.embedding
            FROM chunks c
            JOIN embeddings e ON e.id = c.id
            WHERE c.bucket IN (${placeholders})`,
      args: allowed,
    });

    const scored: RetrievedChunk[] = res.rows.map((row) => {
      const emb = JSON.parse(String(row.embedding)) as number[];
      const trail = row.section == null ? "" : String(row.section);
      return {
        text: String(row.text),
        bucket: String(row.bucket ?? ""),
        source: String(row.source ?? ""),
        section: trail ? trail.split(" > ") : [],
        score: VectorStore.cosine(qv, emb),
      };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
  }

  /** Same results as {@link queryChunks}, as bare text. */
  async query(q: string, k = 6, allowed: string[] = ["base"]): Promise<string[]> {
    return (await this.queryChunks(q, k, allowed)).map((c) => c.text);
  }
}
