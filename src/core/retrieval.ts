import { createClient, type Client as LibsqlClient } from "@libsql/client";
import type OpenAI from "openai";
import { type Bucket, loadKnowledge } from "./loaders";

const EMB_MODEL = "text-embedding-3-large";

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

/**
 * How a {@link VectorStore} obtains its database connection: either credentials
 * to open its own, or an existing libsql client to reuse.
 *
 * Reusing a client is preferred when the store lives alongside other consumers
 * of the same database (route factories, custom routes) — the process then
 * holds one connection instead of one per consumer.
 */
export type VectorStoreOptions = {
  /** Directory of markdown knowledge files. Default: `./config/knowledge` */
  knowledgeDir?: string;
} & (
  | {
      /** Turso database URL */
      databaseUrl: string;
      /** Turso auth token */
      databaseAuthToken: string;
      databaseClient?: never;
    }
  | {
      /** An existing libsql client to reuse instead of opening a second connection */
      databaseClient: LibsqlClient;
      databaseUrl?: never;
      databaseAuthToken?: never;
    }
);

export class VectorStore {
  /**
   * The libsql client backing this store. When a client was injected this is
   * that same instance, so callers holding it (e.g. `ServerDependencies.db`)
   * and the store share one connection.
   */
  readonly db: LibsqlClient;
  private knowledgeDir: string;

  constructor(
    private client: OpenAI,
    options: VectorStoreOptions,
  ) {
    this.db = options.databaseClient
      ? options.databaseClient
      : createClient({
          url: options.databaseUrl,
          authToken: options.databaseAuthToken,
        });
    this.knowledgeDir = options.knowledgeDir || "./config/knowledge";
  }

  // On boot: ingest new chunks and embed only missing ones.
  async build() {
    console.log("🔄 Building knowledge base...");

    // ensure tables exist (idempotent)
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS chunks (id TEXT PRIMARY KEY, bucket TEXT NOT NULL, source TEXT NOT NULL, text TEXT NOT NULL);
    `);
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS embeddings (id TEXT PRIMARY KEY, model TEXT NOT NULL, embedding BLOB NOT NULL);
    `);
    await this.db.execute("CREATE INDEX IF NOT EXISTS idx_chunks_bucket ON chunks(bucket);");

    const docs = loadKnowledge(this.knowledgeDir);
    console.log(`📚 Loaded ${docs.length} knowledge documents`);

    const rows: { id: string; bucket: Bucket; source: string; text: string }[] = [];
    for (const d of docs) {
      for (const part of chunk(d.text)) {
        const id = await sha256(`${d.bucket}|${d.source}|${part}`);
        rows.push({ id, bucket: d.bucket, source: d.source, text: part });
      }
    }

    console.log(`📦 Created ${rows.length} chunks from knowledge documents`);

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
        batch.map((r) => ({
          sql: `INSERT INTO chunks(id,bucket,source,text) VALUES(?,?,?,?)
                ON CONFLICT(id) DO NOTHING`,
          args: [r.id, r.bucket, r.source, r.text],
        })),
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
      console.log("✅ No new chunks to embed - knowledge base is up to date");
      return;
    }

    console.log(`🔮 Embedding ${missing.length} new/updated chunks with ${EMB_MODEL}...`);

    // Embed missing in batches of N
    const textById = new Map(rows.map((r) => [r.id, r.text]));
    const BATCH = 96;
    for (let i = 0; i < missing.length; i += BATCH) {
      const batchIds = missing.slice(i, i + BATCH);
      const inputs = batchIds.map((id) => textById.get(id) || "");
      const emb = await this.client.embeddings.create({ model: EMB_MODEL, input: inputs });
      // See the chunks upsert above: batch(), not transaction(), to keep
      // the connection alive for whatever reads this store does next.
      await this.db.batch(
        emb.data.map((d, idx) => ({
          sql: "INSERT INTO embeddings(id,model,embedding) VALUES(?,?,?)",
          args: [batchIds[idx], EMB_MODEL, JSON.stringify(d.embedding)],
        })),
        "write",
      );
    }

    console.log(`✅ Successfully embedded ${missing.length} new chunks`);
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

    console.log(`🧹 Cleaning up ${staleIds.length} stale chunks...`);

    // Delete stale chunks in batches (embeddings cascade delete automatically)
    const BATCH_SIZE = 500;
    for (let i = 0; i < staleIds.length; i += BATCH_SIZE) {
      const batch = staleIds.slice(i, i + BATCH_SIZE);
      const placeholders = batch.map(() => "?").join(",");

      await this.db.execute({
        sql: `DELETE FROM chunks WHERE id IN (${placeholders})`,
        args: batch,
      });
    }

    console.log(`✓ Cleaned up ${staleIds.length} stale chunks and their embeddings`);
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
  async query(q: string, k = 6, allowed: string[] = ["base"]): Promise<string[]> {
    if (allowed.length === 0) return [];

    const qv = (await this.client.embeddings.create({ model: EMB_MODEL, input: [q] })).data[0]
      .embedding as number[];

    // Pull candidate rows (you can optimize by limiting rows per bucket)
    const placeholders = allowed.map(() => "?").join(",");
    const res = await this.db.execute({
      sql: `SELECT c.id, c.text, e.embedding
            FROM chunks c
            JOIN embeddings e ON e.id = c.id
            WHERE c.bucket IN (${placeholders})`,
      args: allowed,
    });

    const scored: Array<{ s: number; text: string }> = [];
    for (const row of res.rows) {
      const emb = JSON.parse(String(row.embedding)) as number[];
      const s = VectorStore.cosine(qv, emb);
      scored.push({ s, text: String(row.text) });
    }
    scored.sort((a, b) => b.s - a.s);
    return scored.slice(0, k).map((r) => r.text);
  }
}
