import { describe, expect, test } from "bun:test";
import { createSenderRegistry } from "./senders";

describe("createSenderRegistry", () => {
  test("available() is false for an unregistered name", () => {
    const registry = createSenderRegistry();
    expect(registry.available("wa")).toBe(false);
  });

  test("register makes a sender available and sendText reaches it", async () => {
    const registry = createSenderRegistry();
    const sent: Array<{ chatId: string; text: string }> = [];
    registry.register("wa", {
      sendText: async (chatId, text) => {
        sent.push({ chatId, text });
      },
    });

    expect(registry.available("wa")).toBe(true);
    const ok = await registry.sendText("wa", "chat-1", "hello");
    expect(ok).toBe(true);
    expect(sent).toEqual([{ chatId: "chat-1", text: "hello" }]);
  });

  test("unregister removes the sender", async () => {
    const registry = createSenderRegistry();
    registry.register("wa", { sendText: async () => {} });
    registry.unregister("wa");

    expect(registry.available("wa")).toBe(false);
    expect(await registry.sendText("wa", "chat-1", "hi")).toBe(false);
  });

  test("sendText on an unknown name returns false instead of throwing", async () => {
    const registry = createSenderRegistry();
    expect(await registry.sendText("missing", "chat-1", "hi")).toBe(false);
  });

  test("sendText failure is caught and returns false", async () => {
    const registry = createSenderRegistry();
    registry.register("wa", {
      sendText: async () => {
        throw new Error("socket closed");
      },
    });

    expect(await registry.sendText("wa", "chat-1", "hi")).toBe(false);
  });

  test("sendVoice/sendMedia return false when the sender omits them", async () => {
    const registry = createSenderRegistry();
    registry.register("wa", { sendText: async () => {} });

    expect(await registry.sendVoice("wa", "chat-1", { seconds: 3 })).toBe(false);
    expect(await registry.sendMedia("wa", "chat-1", { url: "x" })).toBe(false);
  });

  test("sendVoice/sendMedia reach the sender when provided, and catch failures", async () => {
    const registry = createSenderRegistry();
    const voiceCalls: unknown[] = [];
    registry.register("wa", {
      sendText: async () => {},
      sendVoice: async (_chatId, payload) => {
        voiceCalls.push(payload);
      },
      sendMedia: async () => {
        throw new Error("upload failed");
      },
    });

    expect(await registry.sendVoice("wa", "chat-1", { seconds: 3 })).toBe(true);
    expect(voiceCalls).toEqual([{ seconds: 3 }]);
    expect(await registry.sendMedia("wa", "chat-1", { url: "x" })).toBe(false);
  });
});
