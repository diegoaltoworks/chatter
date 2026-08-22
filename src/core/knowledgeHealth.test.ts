/**
 * Uses a real local (`file::memory:`) libsql client, like retrieval.test.ts,
 * so counts and the orphan/missing joins run against real SQL rather than a
 * faked client.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { createTursoBuildLock } from "./buildLock";
import {
  checkKnowledgeHealth,
  DEFAULT_KNOWLEDGE_HEALTH_INTERVAL_MS,
  scheduleKnowledgeHealthChecks,
} from "./knowledgeHealth";
import { type Embedder, VectorStore } from "./retrieval";

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

function fakeEmbedder(embedding: number[]): Embedder {
  return async (input) => input.map(() => embedding);
}

/** Injectable schedule seam: captures the interval fn/ms instead of using a real timer. */
function fakeSchedule() {
  const calls: { fn: () => void; ms: number }[] = [];
  let stopped = 0;
  return {
    schedule: (fn: () => void, ms: number) => {
      calls.push({ fn, ms });
      return { stop: () => stopped++ };
    },
    calls,
    stoppedCount: () => stopped,
  };
}

async function openMemoryDb() {
  return createClient({ url: "file::memory:", authToken: "" });
}

async function seedKnowledgeBase() {
  const dir = mkdtempSync(join(tmpdir(), "chatter-knowledge-health-"));
  const knowledgeDir = join(dir, "knowledge");
  mkdirSync(join(knowledgeDir, "base"), { recursive: true });
  writeFileSync(join(knowledgeDir, "base", "info.md"), "# Info\nSupport hours are 9-5.");
  const db = await openMemoryDb();
  const store = new VectorStore(fakeEmbedder([1, 0]), { databaseClient: db, knowledgeDir });
  await store.build();
  return { db, dir };
}

describe("checkKnowledgeHealth", () => {
  test("reports chunk/embedding counts by bucket for a healthy store, logging at info", async () => {
    const { db, dir } = await seedKnowledgeBase();
    try {
      const { logger, lines } = collectingLogger();

      const health = await checkKnowledgeHealth(db, logger);

      expect(health.totalChunks).toBe(1);
      expect(health.totalEmbeddings).toBe(1);
      expect(health.chunksByBucket).toEqual({ base: 1 });
      expect(health.orphanedEmbeddings).toBe(0);
      expect(health.missingEmbeddings).toBe(0);
      expect(lines.some((l) => l.startsWith("info") && l.includes("Knowledge base health"))).toBe(
        true,
      );
      expect(lines.some((l) => l.startsWith("warn"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("escalates to warn when totalChunks is 0 - the signature of both incidents", async () => {
    const db = await openMemoryDb();
    // Tables must exist for the query, but stay empty.
    await db.execute(
      "CREATE TABLE IF NOT EXISTS chunks (id TEXT PRIMARY KEY, bucket TEXT NOT NULL, source TEXT NOT NULL, text TEXT NOT NULL)",
    );
    await db.execute(
      "CREATE TABLE IF NOT EXISTS embeddings (id TEXT PRIMARY KEY, model TEXT NOT NULL, embedding BLOB NOT NULL)",
    );
    const { logger, lines } = collectingLogger();

    const health = await checkKnowledgeHealth(db, logger);

    expect(health.totalChunks).toBe(0);
    expect(lines.some((l) => l.startsWith("warn") && l.includes("Knowledge base health"))).toBe(
      true,
    );
  });

  test("escalates to warn and reports orphaned/missing rows correctly", async () => {
    const { db, dir } = await seedKnowledgeBase();
    try {
      // A missing-embedding row: a chunk with no matching embedding.
      await db.execute({
        sql: "INSERT INTO chunks(id,bucket,source,text) VALUES(?,?,?,?)",
        args: ["missing-1", "base", "extra.md", "unfinished chunk"],
      });
      // An orphaned-embedding row: an embedding with no matching chunk.
      await db.execute({
        sql: "INSERT INTO embeddings(id,model,embedding) VALUES(?,?,?)",
        args: ["orphan-1", "text-embedding-3-large", "[1,0]"],
      });
      const { logger, lines } = collectingLogger();

      const health = await checkKnowledgeHealth(db, logger);

      expect(health.totalChunks).toBe(2);
      expect(health.totalEmbeddings).toBe(2);
      expect(health.missingEmbeddings).toBe(1);
      expect(health.orphanedEmbeddings).toBe(1);
      expect(lines.some((l) => l.startsWith("warn") && l.includes("Knowledge base health"))).toBe(
        true,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("scheduleKnowledgeHealthChecks", () => {
  test("runs one check immediately and schedules a periodic re-run on intervalMs by default", async () => {
    const { db, dir } = await seedKnowledgeBase();
    try {
      const { logger, lines } = collectingLogger();
      const { schedule, calls } = fakeSchedule();

      const scheduler = await scheduleKnowledgeHealthChecks({ db, logger, schedule });

      expect(lines.filter((l) => l.includes("Knowledge base health")).length).toBe(1);
      expect(calls).toHaveLength(1);
      expect(calls[0].ms).toBe(DEFAULT_KNOWLEDGE_HEALTH_INTERVAL_MS);

      // Simulate the interval firing.
      calls[0].fn();
      await Promise.resolve();
      await Promise.resolve();

      expect(lines.filter((l) => l.includes("Knowledge base health")).length).toBe(2);

      scheduler.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("enabled: false skips both the immediate run and the periodic schedule", async () => {
    const { db, dir } = await seedKnowledgeBase();
    try {
      const { logger, lines } = collectingLogger();
      const { schedule, calls } = fakeSchedule();

      await scheduleKnowledgeHealthChecks({
        db,
        logger,
        schedule,
        config: { enabled: false },
      });

      expect(lines).toEqual([]);
      expect(calls).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("honors a configured intervalMs and runOnce() is independently callable", async () => {
    const { db, dir } = await seedKnowledgeBase();
    try {
      const { logger } = collectingLogger();
      const { schedule, calls } = fakeSchedule();

      const scheduler = await scheduleKnowledgeHealthChecks({
        db,
        logger,
        schedule,
        config: { intervalMs: 5_000 },
      });

      expect(calls[0].ms).toBe(5_000);
      const health = await scheduler.runOnce();
      expect(health.totalChunks).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("stop() stops the underlying schedule handle", async () => {
    const { db, dir } = await seedKnowledgeBase();
    try {
      const { logger } = collectingLogger();
      const { schedule, stoppedCount } = fakeSchedule();

      const scheduler = await scheduleKnowledgeHealthChecks({ db, logger, schedule });
      scheduler.stop();

      expect(stoppedCount()).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("autoCleanOrphanedEmbeddings deletes orphaned rows and logs the exact count removed", async () => {
    const { db, dir } = await seedKnowledgeBase();
    try {
      await db.execute({
        sql: "INSERT INTO embeddings(id,model,embedding) VALUES(?,?,?)",
        args: ["orphan-1", "text-embedding-3-large", "[1,0]"],
      });
      const { logger, lines } = collectingLogger();

      await scheduleKnowledgeHealthChecks({
        db,
        logger,
        config: { autoCleanOrphanedEmbeddings: true, intervalMs: 0 },
      });

      const remaining = await db.execute("SELECT id FROM embeddings WHERE id = 'orphan-1'");
      expect(remaining.rows).toHaveLength(0);
      expect(lines.some((l) => l.startsWith("warn") && l.includes("deleted 1 orphaned"))).toBe(
        true,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("autoCleanOrphanedEmbeddings defaults off - orphans are reported but left in place", async () => {
    const { db, dir } = await seedKnowledgeBase();
    try {
      await db.execute({
        sql: "INSERT INTO embeddings(id,model,embedding) VALUES(?,?,?)",
        args: ["orphan-1", "text-embedding-3-large", "[1,0]"],
      });
      const { logger } = collectingLogger();

      await scheduleKnowledgeHealthChecks({ db, logger, config: { intervalMs: 0 } });

      const remaining = await db.execute("SELECT id FROM embeddings WHERE id = 'orphan-1'");
      expect(remaining.rows).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("autoCleanOrphanedEmbeddings cannot run concurrently with an in-progress build - it skips and logs why", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chatter-knowledge-health-lock-"));
    const knowledgeDir = join(dir, "knowledge");
    mkdirSync(join(knowledgeDir, "base"), { recursive: true });
    writeFileSync(join(knowledgeDir, "base", "info.md"), "# Info\nSupport hours are 9-5.");

    try {
      const db = await openMemoryDb();

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

      const buildLogger = collectingLogger().logger;
      const store = new VectorStore(gatedEmbed, {
        databaseClient: db,
        knowledgeDir,
        instanceId: "builder",
        logger: buildLogger,
      });

      const buildDone = store.build();
      await embedding; // the build now holds BUILD_LOCK_KEY as "builder"

      // Tables exist by now (build() creates them before embedding); insert
      // an orphan directly so there is something for auto-clean to find.
      await db.execute({
        sql: "INSERT INTO embeddings(id,model,embedding) VALUES(?,?,?)",
        args: ["orphan-1", "text-embedding-3-large", "[1,0]"],
      });

      const { logger, lines } = collectingLogger();
      await scheduleKnowledgeHealthChecks({
        db,
        logger,
        buildLock: createTursoBuildLock(db),
        instanceId: "health-checker",
        config: { autoCleanOrphanedEmbeddings: true, intervalMs: 0 },
      });

      const stillOrphaned = await db.execute("SELECT id FROM embeddings WHERE id = 'orphan-1'");
      expect(stillOrphaned.rows).toHaveLength(1);
      expect(
        lines.some(
          (l) => l.startsWith("warn") && l.includes("skipping orphaned-embeddings cleanup"),
        ),
      ).toBe(true);

      releaseFirst();
      await buildDone;

      // Once the build lock is free, the same cleanup call succeeds.
      const retryLogger = collectingLogger();
      await scheduleKnowledgeHealthChecks({
        db,
        logger: retryLogger.logger,
        buildLock: createTursoBuildLock(db),
        instanceId: "health-checker",
        config: { autoCleanOrphanedEmbeddings: true, intervalMs: 0 },
      });

      const cleaned = await db.execute("SELECT id FROM embeddings WHERE id = 'orphan-1'");
      expect(cleaned.rows).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
