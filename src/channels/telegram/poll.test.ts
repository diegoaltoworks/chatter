import { describe, expect, test } from "bun:test";
import type { Logger } from "../../core/logger";
import { TelegramApiError, type TelegramUpdate } from "./api";
import { pollBackoffMs, retryDelayMs, runLongPoll } from "./poll";

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

function updatesFor(ids: number[]): TelegramUpdate[] {
  return ids.map((id) => ({
    update_id: id,
    message: { message_id: id, chat: { id: 1, type: "private" as const } },
  }));
}

describe("pollBackoffMs", () => {
  test("grows exponentially and caps at a minute", () => {
    expect(pollBackoffMs(1)).toBe(2_000);
    expect(pollBackoffMs(2)).toBe(4_000);
    expect(pollBackoffMs(3)).toBe(8_000);
    expect(pollBackoffMs(50)).toBe(60_000);
  });
});

describe("retryDelayMs", () => {
  test("honours Telegram's retry_after over the backoff, even beyond the cap", () => {
    const error = new TelegramApiError("flood", { errorCode: 429, retryAfterMs: 120_000 });
    expect(retryDelayMs(error, 1)).toBe(120_000);
  });

  test("falls back to the backoff for an ordinary failure", () => {
    expect(retryDelayMs(new Error("boom"), 2)).toBe(4_000);
  });
});

describe("runLongPoll", () => {
  test("advances the offset past every handled update and reports it", async () => {
    const polls: Array<number | undefined> = [];
    const handled: number[] = [];
    const offsets: number[] = [];
    const batches = [updatesFor([10, 11]), updatesFor([12])];
    let round = 0;

    const finalOffset = await runLongPoll({
      getUpdates: async (offset) => {
        polls.push(offset);
        return batches[round++] ?? [];
      },
      handleUpdate: async (update) => {
        handled.push(update.update_id);
      },
      isStopped: () => round > 2,
      sleep: async () => undefined,
      onOffset: (offset) => offsets.push(offset),
      logger: silentLogger(),
    });

    expect(polls).toEqual([undefined, 12, 13]);
    expect(handled).toEqual([10, 11, 12]);
    expect(offsets).toEqual([11, 12, 13]);
    expect(finalOffset).toBe(13);
  });

  test("resumes from initialOffset", async () => {
    const polls: Array<number | undefined> = [];
    let done = false;
    await runLongPoll({
      getUpdates: async (offset) => {
        polls.push(offset);
        done = true;
        return [];
      },
      handleUpdate: async () => undefined,
      isStopped: () => done,
      sleep: async () => undefined,
      initialOffset: 500,
      logger: silentLogger(),
    });
    expect(polls).toEqual([500]);
  });

  test("backs off instead of hammering when getUpdates keeps failing", async () => {
    const slept: number[] = [];
    let attempts = 0;

    await runLongPoll({
      getUpdates: async () => {
        attempts += 1;
        throw new Error("network down");
      },
      handleUpdate: async () => undefined,
      isStopped: () => attempts >= 3,
      sleep: async (ms) => {
        slept.push(ms);
      },
      logger: silentLogger(),
    });

    expect(attempts).toBe(3);
    expect(slept).toEqual([2_000, 4_000]);
  });

  test("resets the backoff after a successful poll", async () => {
    const slept: number[] = [];
    const script: Array<"fail" | "ok"> = ["fail", "fail", "ok", "fail"];
    let index = 0;

    await runLongPoll({
      getUpdates: async () => {
        const step = script[index++] ?? "fail";
        if (step === "fail") throw new Error("blip");
        return [];
      },
      handleUpdate: async () => undefined,
      isStopped: () => slept.length >= 3,
      sleep: async (ms) => {
        slept.push(ms);
      },
      logger: silentLogger(),
    });

    expect(slept).toEqual([2_000, 4_000, 2_000]);
  });

  test("waits out a 429 flood control for exactly as long as Telegram asked", async () => {
    const slept: number[] = [];
    let attempts = 0;

    await runLongPoll({
      getUpdates: async () => {
        attempts += 1;
        throw new TelegramApiError("Too Many Requests", { errorCode: 429, retryAfterMs: 15_000 });
      },
      handleUpdate: async () => undefined,
      isStopped: () => attempts >= 2,
      sleep: async (ms) => {
        slept.push(ms);
      },
      logger: silentLogger(),
    });

    expect(slept).toEqual([15_000]);
  });

  test("a throwing handler is logged and the offset still advances past it", async () => {
    const handled: number[] = [];
    const logger = silentLogger();
    let round = 0;

    const finalOffset = await runLongPoll({
      getUpdates: async () => (round++ === 0 ? updatesFor([7, 8]) : []),
      handleUpdate: async (update) => {
        handled.push(update.update_id);
        if (update.update_id === 7) throw new Error("poison");
      },
      isStopped: () => round > 1,
      sleep: async () => undefined,
      logger,
    });

    expect(handled).toEqual([7, 8]);
    expect(finalOffset).toBe(9);
    expect(logger.warnings.some((line) => line.includes("update 7 handling failed"))).toBe(true);
  });

  test("a stop during a failed poll neither logs nor sleeps", async () => {
    const slept: number[] = [];
    const logger = silentLogger();
    let stopped = false;

    await runLongPoll({
      getUpdates: async () => {
        stopped = true;
        throw new Error("aborted");
      },
      handleUpdate: async () => undefined,
      isStopped: () => stopped,
      sleep: async (ms) => {
        slept.push(ms);
      },
      logger,
    });

    expect(slept).toEqual([]);
    expect(logger.warnings).toEqual([]);
  });

  test("a stop mid-batch abandons the remaining updates", async () => {
    const handled: number[] = [];
    let stopped = false;

    await runLongPoll({
      getUpdates: async () => updatesFor([1, 2, 3]),
      handleUpdate: async (update) => {
        handled.push(update.update_id);
        stopped = true;
      },
      isStopped: () => stopped,
      sleep: async () => undefined,
      logger: silentLogger(),
    });

    expect(handled).toEqual([1]);
  });
});
