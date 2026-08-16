import { describe, expect, test } from "bun:test";
import type { Logger } from "../../core/logger";
import { MatrixApiError, type MatrixSyncResponse } from "./api";
import { retryDelayMs, runMatrixSyncLoop, syncBackoffMs } from "./sync";

function silentLogger(): Logger & { warnings: string[] } {
  const warnings: string[] = [];
  return {
    warnings,
    debug: () => undefined,
    info: () => undefined,
    warn: (...args: unknown[]) => {
      warnings.push(String(args[0]));
    },
    error: () => undefined,
  };
}

function batch(nextBatch: string): MatrixSyncResponse {
  return { next_batch: nextBatch };
}

describe("syncBackoffMs", () => {
  test("grows exponentially and caps at a minute", () => {
    expect(syncBackoffMs(1)).toBe(2_000);
    expect(syncBackoffMs(2)).toBe(4_000);
    expect(syncBackoffMs(3)).toBe(8_000);
    expect(syncBackoffMs(50)).toBe(60_000);
  });
});

describe("retryDelayMs", () => {
  test("honours M_LIMIT_EXCEEDED's retry_after_ms over the backoff, even beyond the cap", () => {
    const error = new MatrixApiError("rate limited", {
      errcode: "M_LIMIT_EXCEEDED",
      retryAfterMs: 120_000,
    });
    expect(retryDelayMs(error, 1)).toBe(120_000);
  });

  test("falls back to the backoff for an ordinary failure", () => {
    expect(retryDelayMs(new Error("boom"), 2)).toBe(4_000);
  });
});

describe("runMatrixSyncLoop", () => {
  test("advances the since token past every handled batch and reports it", async () => {
    const requestedSince: Array<string | undefined> = [];
    const handledBatches: string[] = [];
    const emittedSince: string[] = [];
    const batches = [batch("s1"), batch("s2"), batch("s3")];
    let round = 0;
    let handledCount = 0;

    const finalSince = await runMatrixSyncLoop({
      sync: async (since) => {
        requestedSince.push(since);
        return batches[round++] ?? batch("s-extra");
      },
      handleSync: async (response) => {
        handledBatches.push(response.next_batch);
        handledCount++;
      },
      isStopped: () => handledCount >= 3,
      sleep: async () => undefined,
      onSince: (since) => emittedSince.push(since),
      logger: silentLogger(),
    });

    expect(requestedSince).toEqual([undefined, "s1", "s2"]);
    expect(handledBatches).toEqual(["s1", "s2", "s3"]);
    expect(emittedSince).toEqual(["s1", "s2", "s3"]);
    expect(finalSince).toBe("s3");
  });

  test("resumes from initialSince", async () => {
    const requestedSince: Array<string | undefined> = [];
    let done = false;
    await runMatrixSyncLoop({
      sync: async (since) => {
        requestedSince.push(since);
        done = true;
        return batch("s1");
      },
      handleSync: async () => undefined,
      isStopped: () => done,
      sleep: async () => undefined,
      initialSince: "resume-token",
      logger: silentLogger(),
    });
    expect(requestedSince).toEqual(["resume-token"]);
  });

  test("backs off instead of hammering when sync keeps failing", async () => {
    const slept: number[] = [];
    let attempts = 0;

    await runMatrixSyncLoop({
      sync: async () => {
        attempts += 1;
        throw new Error("network down");
      },
      handleSync: async () => undefined,
      isStopped: () => attempts >= 3,
      sleep: async (ms) => {
        slept.push(ms);
      },
      logger: silentLogger(),
    });

    expect(attempts).toBe(3);
    expect(slept).toEqual([2_000, 4_000]);
  });

  test("resets the backoff after a successful sync", async () => {
    const slept: number[] = [];
    const script: Array<"fail" | "ok"> = ["fail", "fail", "ok", "fail"];
    let index = 0;

    await runMatrixSyncLoop({
      sync: async () => {
        const step = script[index++] ?? "fail";
        if (step === "fail") throw new Error("blip");
        return batch("s1");
      },
      handleSync: async () => undefined,
      isStopped: () => slept.length >= 3,
      sleep: async (ms) => {
        slept.push(ms);
      },
      logger: silentLogger(),
    });

    expect(slept).toEqual([2_000, 4_000, 2_000]);
  });

  test("waits out an M_LIMIT_EXCEEDED for exactly as long as the homeserver asked", async () => {
    const slept: number[] = [];
    let attempts = 0;

    await runMatrixSyncLoop({
      sync: async () => {
        attempts += 1;
        throw new MatrixApiError("rate limited", {
          errcode: "M_LIMIT_EXCEEDED",
          retryAfterMs: 15_000,
        });
      },
      handleSync: async () => undefined,
      isStopped: () => attempts >= 2,
      sleep: async (ms) => {
        slept.push(ms);
      },
      logger: silentLogger(),
    });

    expect(slept).toEqual([15_000]);
  });

  test("a throwing handler is logged and the since token still advances past it", async () => {
    const handled: string[] = [];
    const logger = silentLogger();
    let round = 0;
    let handledCount = 0;

    const finalSince = await runMatrixSyncLoop({
      sync: async () => (round++ === 0 ? batch("poison") : batch("s2")),
      handleSync: async (response) => {
        handled.push(response.next_batch);
        handledCount++;
        if (response.next_batch === "poison") throw new Error("bad batch");
      },
      isStopped: () => handledCount >= 2,
      sleep: async () => undefined,
      logger,
    });

    expect(handled).toEqual(["poison", "s2"]);
    expect(finalSince).toBe("s2");
    expect(logger.warnings.some((line) => line.includes("poison handling failed"))).toBe(true);
  });

  test("a stop during a failed sync neither logs nor sleeps", async () => {
    const slept: number[] = [];
    const logger = silentLogger();
    let stopped = false;

    await runMatrixSyncLoop({
      sync: async () => {
        stopped = true;
        throw new Error("aborted");
      },
      handleSync: async () => undefined,
      isStopped: () => stopped,
      sleep: async (ms) => {
        slept.push(ms);
      },
      logger,
    });

    expect(slept).toEqual([]);
    expect(logger.warnings).toEqual([]);
  });

  test("a stop right after a batch lands still skips handling it", async () => {
    const handled: string[] = [];
    let stopped = false;

    await runMatrixSyncLoop({
      sync: async () => {
        stopped = true;
        return batch("s1");
      },
      handleSync: async (response) => {
        handled.push(response.next_batch);
      },
      isStopped: () => stopped,
      sleep: async () => undefined,
      logger: silentLogger(),
    });

    expect(handled).toEqual([]);
  });
});
