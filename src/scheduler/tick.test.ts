import { describe, expect, test } from "bun:test";
import type { ChannelSenderRegistry } from "../channels/senders";
import { runTick } from "./tick";
import type { ScheduleClaimStore, ScheduleEntry } from "./types";

function fakeClaims(): ScheduleClaimStore & { claimed: Map<string, boolean> } {
  const claimed = new Map<string, boolean>();
  return {
    claimed,
    async claim(id) {
      if (claimed.get(id)) return false;
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
    ...overrides,
  };
}

function entry(overrides: Partial<ScheduleEntry> = {}): ScheduleEntry {
  return { id: "job-1", fireAt: 1_000, channel: "whatsapp", chatId: "chat-1", ...overrides };
}

const baseOptions = { graceMs: 5_000, fallbackMessage: "fallback" };

describe("runTick", () => {
  test("sends a due entry within grace and claims it", async () => {
    const claims = fakeClaims();
    const senders = fakeSenders();

    const result = await runTick([entry()], { claims, senders, now: 1_000, ...baseOptions });

    expect(result.sent).toEqual(["job-1"]);
    expect(claims.claimed.get("job-1")).toBe(true);
  });

  test("skips entries past their grace window without claiming them", async () => {
    const claims = fakeClaims();
    const senders = fakeSenders();

    const result = await runTick([entry({ fireAt: 0 })], {
      claims,
      senders,
      now: 10_000,
      ...baseOptions,
    });

    expect(result.stale).toEqual(["job-1"]);
    expect(result.sent).toEqual([]);
    expect(claims.claimed.size).toBe(0);
  });

  test("does not deliver future entries", async () => {
    const claims = fakeClaims();
    const senders = fakeSenders();

    const result = await runTick([entry({ fireAt: 2_000 })], {
      claims,
      senders,
      now: 1_000,
      ...baseOptions,
    });

    expect(result.sent).toEqual([]);
    expect(result.stale).toEqual([]);
    expect(result.notClaimed).toEqual([]);
  });

  test("two concurrent instances never double-send — only the claim winner delivers", async () => {
    const claims = fakeClaims();
    const senders = fakeSenders();
    const options = { claims, senders, now: 1_000, ...baseOptions };

    const [first, second] = await Promise.all([
      runTick([entry()], options),
      runTick([entry()], options),
    ]);

    expect(first.sent.length + second.sent.length).toBe(1);
    expect(first.notClaimed.length + second.notClaimed.length).toBe(1);
  });

  test("a send failure releases the claim so the entry is claimable again within grace", async () => {
    const claims = fakeClaims();
    const failingSenders = fakeSenders({ sendText: async () => false });

    const first = await runTick([entry()], {
      claims,
      senders: failingSenders,
      now: 1_000,
      ...baseOptions,
    });
    expect(first.failed).toEqual(["job-1"]);
    expect(claims.claimed.has("job-1")).toBe(false);

    const workingSenders = fakeSenders();
    const retry = await runTick([entry()], {
      claims,
      senders: workingSenders,
      now: 1_500,
      ...baseOptions,
    });
    expect(retry.sent).toEqual(["job-1"]);
  });

  test("a released claim is not retried once the entry falls past grace", async () => {
    const claims = fakeClaims();
    const failingSenders = fakeSenders({ sendText: async () => false });

    await runTick([entry()], { claims, senders: failingSenders, now: 1_000, ...baseOptions });
    expect(claims.claimed.has("job-1")).toBe(false);

    const retry = await runTick([entry()], {
      claims,
      senders: fakeSenders(),
      now: 10_000,
      ...baseOptions,
    });
    expect(retry.stale).toEqual(["job-1"]);
    expect(retry.sent).toEqual([]);
  });

  test("a throwing sender releases the claim instead of blocking the entry", async () => {
    const claims = fakeClaims();
    const throwingSenders = fakeSenders({
      sendText: async () => {
        throw new Error("boom");
      },
    });

    const result = await runTick([entry()], {
      claims,
      senders: throwingSenders,
      now: 1_000,
      ...baseOptions,
    });

    expect(result.failed).toEqual(["job-1"]);
    expect(claims.claimed.has("job-1")).toBe(false);
  });

  test("a compose failure falls back to the fallback message and still delivers", async () => {
    const claims = fakeClaims();
    let sentText: string | undefined;
    const senders = fakeSenders({
      sendText: async (_name, _chatId, text) => {
        sentText = text;
        return true;
      },
    });
    const compose = () => {
      throw new Error("boom");
    };

    const result = await runTick([entry()], {
      claims,
      senders,
      now: 1_000,
      ...baseOptions,
      compose,
    });

    expect(result.sent).toEqual(["job-1"]);
    expect(sentText).toBe("fallback");
  });
});
