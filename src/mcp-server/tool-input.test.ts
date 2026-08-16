import { describe, expect, test } from "bun:test";
import { resolveConversationMessages } from "./tool-input";

describe("resolveConversationMessages", () => {
  test("prefers messages when both are provided", () => {
    const messages = [{ role: "user" as const, content: "hi" }];

    expect(resolveConversationMessages("ignored", messages)).toBe(messages);
  });

  test("wraps a single message into a one-turn conversation", () => {
    expect(resolveConversationMessages("hello", undefined)).toEqual([
      { role: "user", content: "hello" },
    ]);
  });

  test("throws when neither message nor messages is provided", () => {
    expect(() => resolveConversationMessages(undefined, undefined)).toThrow(
      "Either 'message' or 'messages' is required",
    );
  });

  test("passes an empty messages array through unchanged", () => {
    // prepareChat rejects it downstream with a clearer "no user message"
    // error; this helper only resolves which input source to use.
    expect(resolveConversationMessages(undefined, [])).toEqual([]);
  });
});
