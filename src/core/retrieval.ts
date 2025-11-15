import { type Client as LibsqlClient, createClient } from "@libsql/client";
import type OpenAI from "openai";
import { type Bucket, type LoadedDoc, loadKnowledge } from "./loaders";

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

export class VectorStore {
  private db: LibsqlClient;
  private knowledgeDir: string;

  constructor(
    private client: OpenAI,
    options: {
      databaseUrl: string;
      databaseAuthToken: string;
      knowledgeDir?: string;
    },
  ) {
    this.db = createClient({
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

    // Upsert chunks
    const tx = await this.db.transaction("write");
    try {
      for (const r of rows) {
        await tx.execute({
          sql: `INSERT INTO chunks(id,bucket,source,text) VALUES(?,?,?,?)
                ON CONFLICT(id) DO NOTHING`,
          args: [r.id, r.bucket, r.source, r.text],
        });
      }
      await tx.commit();
    } catch (e) {
      await tx.rollback();
      throw e;
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
      const tx2 = await this.db.transaction("write");
      try {
        emb.data.forEach((d, idx) => {
          const id = batchIds[idx];
          tx2.execute({
            sql: "INSERT INTO embeddings(id,model,embedding) VALUES(?,?,?)",
            args: [id, EMB_MODEL, JSON.stringify(d.embedding)],
          });
        });
        await tx2.commit();
      } catch (e) {
        await tx2.rollback();
        throw e;
      }
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

  // Retrieve top-k across allowed buckets; compute similarity in app (simple & portable).
  async query(q: string, k = 6, allowed: Bucket[] = ["base"]): Promise<string[]> {
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
