import { describe, expect, test } from "bun:test";
import type { ChannelSenderRegistry } from "../channels/senders";
import { deliver } from "./deliver";
import type { ScheduleEntry } from "./types";

const entry: ScheduleEntry = { id: "job-1", fireAt: 1_000, channel: "whatsapp", chatId: "chat-1" };

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

describe("deliver", () => {
  test("sends text when voice is not attempted", async () => {
    let textCalls = 0;
    const senders = fakeSenders({
      sendText: async () => {
        textCalls += 1;
        return true;
      },
    });

    expect(await deliver(entry, "hi", { senders })).toBe(true);
    expect(textCalls).toBe(1);
  });

  test("tries voice first when voiceAttempted, and skips text on success", async () => {
    let textCalls = 0;
    const senders = fakeSenders({
      sendVoice: async () => true,
      sendText: async () => {
        textCalls += 1;
        return true;
      },
    });

    expect(await deliver(entry, "hi", { senders, voiceAttempted: true })).toBe(true);
    expect(textCalls).toBe(0);
  });

  test("falls back to text when voice is unsupported or fails", async () => {
    const senders = fakeSenders({ sendVoice: async () => false, sendText: async () => true });

    expect(await deliver(entry, "hi", { senders, voiceAttempted: true })).toBe(true);
  });

  test("reports failure when text also fails", async () => {
    const senders = fakeSenders({ sendText: async () => false });

    expect(await deliver(entry, "hi", { senders })).toBe(false);
  });
});
