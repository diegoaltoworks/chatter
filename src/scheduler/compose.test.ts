import { describe, expect, test } from "bun:test";
import type OpenAI from "openai";
import { composeMessage, createAnswerCompose } from "./compose";
import type { ScheduleEntry } from "./types";

const entry: ScheduleEntry = { id: "job-1", fireAt: 1_000, channel: "whatsapp", chatId: "chat-1" };

describe("composeMessage", () => {
  test("falls back to the static message when no compose fn is given", async () => {
    expect(await composeMessage(entry, undefined, "fallback")).toBe("fallback");
  });

  test("uses the compose result when it succeeds", async () => {
    expect(await composeMessage(entry, () => "hello", "fallback")).toBe("hello");
  });

  test("falls back on a blank compose result", async () => {
    expect(await composeMessage(entry, () => "   ", "fallback")).toBe("fallback");
  });

  test("falls back when compose throws, never blocking delivery", async () => {
    const compose = () => {
      throw new Error("boom");
    };
    expect(await composeMessage(entry, compose, "fallback")).toBe("fallback");
  });

  test("falls back when compose rejects", async () => {
    const compose = async () => {
      throw new Error("boom");
    };
    expect(await composeMessage(entry, compose, "fallback")).toBe("fallback");
  });
});

describe("createAnswerCompose", () => {
  test("returns the configured answerFn's content", async () => {
    const compose = createAnswerCompose({
      client: {} as OpenAI,
      system: "system prompt",
      buildMessages: () => [{ role: "user", content: "hi" }],
      answerFn: async () => "composed message",
    });

    expect(await compose(entry)).toBe("composed message");
  });
});
