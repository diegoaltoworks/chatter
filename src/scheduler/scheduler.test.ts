import { describe, expect, test } from "bun:test";
import { createClient } from "@libsql/client";
import type { ChannelSenderRegistry } from "../channels/senders";
import { createScheduler } from "./scheduler";
import type { ScheduleClaimStore, ScheduleEntry } from "./types";

function memoryClient() {
  return createClient({ url: ":memory:" });
}

/** An in-memory `ScheduleClaimStore` - proves `claimStore` fully replaces the Turso-backed default, no `db` calls involved. */
function fakeClaimStore(): ScheduleClaimStore & { claimed: Map<string, true> } {
  const claimed = new Map<string, true>();
  return {
    claimed,
    async claim(id) {
      if (claimed.has(id)) return false;
      claimed.set(id, true);
      return true;
    },
    async release(id) {
      claimed.delete(id);
    },
  };
}

function fakeSenders(overrides: Partial<ChannelSenderRegistry> = {}): ChannelSenderRegistry {
  return {
    register: () => {},
    unregister: () => {},
    available: () => true,
    sendText: async () => true,
    sendVoice: async () => false,
    sendMedia: async () => false,
    sendReaction: async () => false,
    ...overrides,
  };
}

/** Captures the interval callback instead of using real timers, so a test fires ticks deterministically. */
function fakeSchedule() {
  let fire: (() => void) | undefined;
  let stopCalls = 0;
  return {
    schedule: (fn: () => void) => {
      fire = fn;
      return {
        stop: () => {
          stopCalls += 1;
        },
      };
    },
    fire: () => fire?.(),
    get stopCalls() {
      return stopCalls;
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createScheduler", () => {
  test("tickOnce fetches pending entries and delivers due ones", async () => {
    const entries: ScheduleEntry[] = [
      { id: "job-1", fireAt: Date.now() - 1_000, channel: "whatsapp", chatId: "chat-1" },
    ];
    let sent = 0;
    const scheduler = createScheduler({
      db: memoryClient(),
      senders: fakeSenders({
        sendText: async () => {
          sent += 1;
          return true;
        },
      }),
      fetchPending: () => entries,
      fallbackMessage: "fallback",
    });

    const result = await scheduler.tickOnce();

    expect(result.sent).toEqual(["job-1"]);
    expect(sent).toBe(1);
  });

  test("an injected claimStore replaces the Turso-backed default entirely", async () => {
    const entries: ScheduleEntry[] = [
      { id: "job-1", fireAt: Date.now() - 1_000, channel: "whatsapp", chatId: "chat-1" },
    ];
    const store = fakeClaimStore();
    const db = memoryClient();
    let sent = 0;
    const scheduler = createScheduler({
      db,
      claimStore: store,
      senders: fakeSenders({
        sendText: async () => {
          sent += 1;
          return true;
        },
      }),
      fetchPending: () => entries,
    });

    const result = await scheduler.tickOnce();

    expect(result.sent).toEqual(["job-1"]);
    expect(sent).toBe(1);
    expect(store.claimed.has("job-1")).toBe(true);

    const tables = await db.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='chatter_schedule_claims'",
    );
    expect(tables.rows).toHaveLength(0);
  });

  test("does not deliver entries that are not yet due", async () => {
    const entries: ScheduleEntry[] = [
      { id: "job-1", fireAt: Date.now() + 60_000, channel: "whatsapp", chatId: "chat-1" },
    ];
    const scheduler = createScheduler({
      db: memoryClient(),
      senders: fakeSenders(),
      fetchPending: () => entries,
    });

    const result = await scheduler.tickOnce();

    expect(result.sent).toEqual([]);
  });

  test("start/stop are idempotent and stop() invokes the schedule's stop handle", () => {
    const control = fakeSchedule();
    const scheduler = createScheduler({
      db: memoryClient(),
      senders: fakeSenders(),
      fetchPending: () => [],
      schedule: control.schedule,
    });

    scheduler.start();
    scheduler.start(); // no-op when already started
    scheduler.stop();
    scheduler.stop(); // no-op when already stopped

    expect(control.stopCalls).toBe(1);
  });

  test("a fired tick calls onTick with the result", async () => {
    const { schedule, fire } = fakeSchedule();
    let ticks: unknown[] = [];
    const scheduler = createScheduler({
      db: memoryClient(),
      senders: fakeSenders(),
      fetchPending: () => [],
      schedule,
      onTick: (result) => {
        ticks = [...ticks, result];
      },
    });

    scheduler.start();
    fire();
    await flush();

    expect(ticks).toHaveLength(1);
  });

  test("a rejecting fetchPending calls onError instead of throwing out of the interval", async () => {
    const { schedule, fire } = fakeSchedule();
    let capturedError: unknown;
    const scheduler = createScheduler({
      db: memoryClient(),
      senders: fakeSenders(),
      fetchPending: () => Promise.reject(new Error("boom")),
      schedule,
      onError: (error) => {
        capturedError = error;
      },
    });

    scheduler.start();
    fire();
    await flush();

    expect((capturedError as Error).message).toBe("boom");
  });

  test("a fire while the previous tick is still running is skipped, not queued", async () => {
    const { schedule, fire } = fakeSchedule();
    let tickStarts = 0;
    let resolveFirst: (() => void) | undefined;
    const scheduler = createScheduler({
      db: memoryClient(),
      senders: fakeSenders(),
      fetchPending: () => {
        tickStarts += 1;
        return new Promise<ScheduleEntry[]>((resolve) => {
          resolveFirst = () => resolve([]);
        });
      },
      schedule,
    });

    scheduler.start();
    fire(); // first tick starts and hangs on fetchPending
    await Promise.resolve();
    fire(); // fires again while the first tick is still in flight

    expect(tickStarts).toBe(1);

    resolveFirst?.();
    await flush();
  });
});
