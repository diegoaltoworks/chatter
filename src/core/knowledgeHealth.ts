/**
 * Post-boot and periodic health checks for the default `VectorStore`
 * knowledge base, so a collapse is visible in logs the moment it happens
 * instead of waiting for a user to notice broken answers - the gap that let
 * two knowledge-base wipes go unnoticed until someone spotted broken
 * answers.
 */

import type { Client as LibsqlClient } from "@libsql/client";
import {
  BUILD_LOCK_KEY,
  BUILD_LOCK_STALE_MS,
  type BuildLock,
  createTursoBuildLock,
} from "./buildLock";
import { createConsoleLogger, type Logger } from "./logger";

export interface KnowledgeHealth {
  chunksByBucket: Record<string, number>;
  totalChunks: number;
  totalEmbeddings: number;
  /** Embeddings rows with no matching chunks row. */
  orphanedEmbeddings: number;
  /** Chunks rows with no matching embeddings row (e.g. a build interrupted mid-embed). */
  missingEmbeddings: number;
}

/**
 * Read-only snapshot of chunks/embeddings consistency, logged at `info` -
 * escalating to `warn` when `totalChunks === 0` (the exact signature of both
 * knowledge-base wipes) or `orphanedEmbeddings > 0`. The query shape mirrors
 * the diagnostic used live to investigate the second incident.
 */
export async function checkKnowledgeHealth(
  db: LibsqlClient,
  logger: Logger,
): Promise<KnowledgeHealth> {
  const [byBucket, totalChunksRes, totalEmbeddingsRes, orphanedRes, missingRes] = await Promise.all(
    [
      db.execute("SELECT bucket, COUNT(*) as count FROM chunks GROUP BY bucket"),
      db.execute("SELECT COUNT(*) as count FROM chunks"),
      db.execute("SELECT COUNT(*) as count FROM embeddings"),
      db.execute(
        "SELECT COUNT(*) as count FROM embeddings e LEFT JOIN chunks c ON c.id = e.id WHERE c.id IS NULL",
      ),
      db.execute(
        "SELECT COUNT(*) as count FROM chunks c LEFT JOIN embeddings e ON e.id = c.id WHERE e.id IS NULL",
      ),
    ],
  );

  const chunksByBucket: Record<string, number> = {};
  for (const row of byBucket.rows) {
    chunksByBucket[String(row.bucket)] = Number(row.count ?? 0);
  }

  const health: KnowledgeHealth = {
    chunksByBucket,
    totalChunks: Number(totalChunksRes.rows[0]?.count ?? 0),
    totalEmbeddings: Number(totalEmbeddingsRes.rows[0]?.count ?? 0),
    orphanedEmbeddings: Number(orphanedRes.rows[0]?.count ?? 0),
    missingEmbeddings: Number(missingRes.rows[0]?.count ?? 0),
  };

  const summary =
    `chunksByBucket=${JSON.stringify(health.chunksByBucket)} totalChunks=${health.totalChunks} ` +
    `totalEmbeddings=${health.totalEmbeddings} orphanedEmbeddings=${health.orphanedEmbeddings} ` +
    `missingEmbeddings=${health.missingEmbeddings}`;
  if (health.totalChunks === 0 || health.orphanedEmbeddings > 0) {
    logger.warn(`Knowledge base health check: ${summary}`);
  } else {
    logger.info(`Knowledge base health check: ${summary}`);
  }

  return health;
}

/**
 * Deletes embeddings rows with no matching chunk, but only while holding the
 * same {@link BuildLock} `VectorStore.build()` uses - skips (logging why)
 * rather than racing an in-progress build, since that build may be about to
 * write the very chunk row an orphan is momentarily missing.
 */
async function cleanOrphanedEmbeddings(
  db: LibsqlClient,
  buildLock: BuildLock,
  instanceId: string,
  logger: Logger,
): Promise<void> {
  const acquired = await buildLock.tryAcquire(
    BUILD_LOCK_KEY,
    instanceId,
    Date.now(),
    BUILD_LOCK_STALE_MS,
  );
  if (!acquired) {
    logger.warn(
      "Knowledge health: skipping orphaned-embeddings cleanup - the build lock is held by another instance.",
    );
    return;
  }
  try {
    const result = await db.execute(
      "DELETE FROM embeddings WHERE id NOT IN (SELECT id FROM chunks)",
    );
    if (result.rowsAffected > 0) {
      logger.warn(`Knowledge health: deleted ${result.rowsAffected} orphaned embedding row(s).`);
    }
  } finally {
    await buildLock.release(BUILD_LOCK_KEY, instanceId);
  }
}

export interface KnowledgeHealthCheckConfig {
  /** Run post-boot and periodic health checks. Default: true. */
  enabled?: boolean;
  /** How often to re-run the check after boot. Default: 30 minutes. */
  intervalMs?: number;
  /**
   * Delete orphaned embeddings rows (no matching chunk) whenever a check
   * finds them. Default: false - opt-in, since it's a delete even though a
   * safe/idempotent one. Under normal operation orphans should be rare
   * (`cleanupStaleChunks` already deletes a stale chunk and its embedding
   * together); this exists chiefly to clean up historical damage and catch
   * any future code path that doesn't maintain that invariant.
   */
  autoCleanOrphanedEmbeddings?: boolean;
}

export const DEFAULT_KNOWLEDGE_HEALTH_INTERVAL_MS = 30 * 60_000;

export interface KnowledgeHealthScheduler {
  /** Runs one check immediately, applying auto-clean if configured. */
  runOnce(): Promise<KnowledgeHealth>;
  /** Stops periodic re-checks. Safe to call even if periodic checks never started. */
  stop(): void;
}

export interface ScheduleKnowledgeHealthChecksOptions {
  db: LibsqlClient;
  config?: KnowledgeHealthCheckConfig;
  /** Default: a console logger writing to stderr. */
  logger?: Logger;
  /** Default: a lock table in `db` (see buildLock.ts) - the same lock `VectorStore.build()` uses. */
  buildLock?: BuildLock;
  /** Identifies this process while it holds the build lock during cleanup. Default: a random id. */
  instanceId?: string;
  /** Injectable for tests; defaults to `setInterval`/`clearInterval`. */
  schedule?: (fn: () => void, ms: number) => { stop: () => void };
}

const defaultSchedule: NonNullable<ScheduleKnowledgeHealthChecksOptions["schedule"]> = (fn, ms) => {
  const timer = setInterval(fn, ms);
  if (typeof timer === "object" && "unref" in timer) timer.unref();
  return { stop: () => clearInterval(timer) };
};

/**
 * Runs {@link checkKnowledgeHealth} once immediately and, unless disabled,
 * again on `intervalMs` via an unref'd timer - so it never blocks process
 * exit or leaves an open handle in tests. `enabled: false` skips both the
 * immediate run and the periodic one.
 */
export async function scheduleKnowledgeHealthChecks(
  options: ScheduleKnowledgeHealthChecksOptions,
): Promise<KnowledgeHealthScheduler> {
  const logger = options.logger ?? createConsoleLogger();
  const enabled = options.config?.enabled !== false;
  const intervalMs = options.config?.intervalMs ?? DEFAULT_KNOWLEDGE_HEALTH_INTERVAL_MS;
  const autoClean = options.config?.autoCleanOrphanedEmbeddings === true;
  const buildLock = options.buildLock ?? createTursoBuildLock(options.db);
  const instanceId = options.instanceId ?? crypto.randomUUID();
  const schedule = options.schedule ?? defaultSchedule;

  async function runOnce(): Promise<KnowledgeHealth> {
    const health = await checkKnowledgeHealth(options.db, logger);
    if (autoClean && health.orphanedEmbeddings > 0) {
      await cleanOrphanedEmbeddings(options.db, buildLock, instanceId, logger);
    }
    return health;
  }

  let handle: { stop: () => void } | undefined;
  if (enabled) {
    await runOnce();
    if (intervalMs > 0) {
      // A tick slower than intervalMs (a large database, a slow cleanup)
      // must not pile up concurrent runs - skip a tick already in flight,
      // same rule `scheduler.ts`'s ticker follows.
      let ticking = false;
      handle = schedule(() => {
        if (ticking) return;
        ticking = true;
        runOnce()
          .catch((error) => logger.error("Knowledge health check failed:", error))
          .finally(() => {
            ticking = false;
          });
      }, intervalMs);
    }
  }

  return {
    runOnce,
    stop: () => handle?.stop(),
  };
}
