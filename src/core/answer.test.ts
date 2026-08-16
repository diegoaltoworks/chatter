/**
 * Brain hook tests
 *
 * Uses a faked OpenAI client so both the built-in completion path and the
 * `answerFn` path can be asserted without touching OpenAI.
 */

import { describe, expect, test } from "bun:test";
import type OpenAI from "openai";
import { type AnswerFnInput, answerOnce, answerStream, applyTransformReply } from "./answer";
import type { PipelineMessage } from "./pipeline";

interface CreateCall {
  model: string;
  messages: { role: string; content: string }[];
}

function createFakeClient(reply = "built-in answer") {
  const calls: CreateCall[] = [];

  const client = {
    chat: {
      completions: {
        create: async (opts: CreateCall & { stream?: boolean }) => {
          calls.push({ model: opts.model, messages: opts.messages });
          if (opts.stream) {
            return (async function* () {
              yield { choices: [{ delta: { content: reply } }] };
              yield { choices: [{ delta: { content: " continued" } }] };
            })();
          }
          return {
            choices: [{ message: { content: reply } }],
            usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
          };
        },
      },
    },
  } as unknown as OpenAI;

  return { client, calls };
}

const messages: PipelineMessage[] = [
  { role: "user", content: "first" },
  { role: "assistant", content: "reply" },
  { role: "user", content: "latest question" },
];

async function collect(stream: AsyncGenerator<string>) {
  const chunks: string[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

describe("answerOnce", () => {
  test("uses the built-in completion when no answerFn is configured", async () => {
    const { client, calls } = createFakeClient();

    const out = await answerOnce({
      client,
      system: "assembled system",
      messages,
      mode: "public",
      model: "gpt-4o-mini",
    });

    expect(out.content).toBe("built-in answer");
    expect(out.usage).toEqual({ prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 });
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe("gpt-4o-mini");
    expect(calls[0].messages[0]).toEqual({ role: "system", content: "assembled system" });
  });

  test("hands the assembled prompt, conversation, mode, sender and conversationId to answerFn", async () => {
    const { client, calls } = createFakeClient();
    const seen: AnswerFnInput[] = [];

    const out = await answerOnce({
      answerFn: async (input) => {
        seen.push(input);
        return "brain answer";
      },
      client,
      system: "assembled system",
      messages,
      mode: "private",
      sender: "+10000000000",
      conversationId: "conv-1",
    });

    expect(out.content).toBe("brain answer");
    expect(seen).toEqual([
      {
        system: "assembled system",
        messages,
        mode: "private",
        sender: "+10000000000",
        conversationId: "conv-1",
      },
    ]);
    // The brain replaces the completion entirely — no upstream call is made.
    expect(calls).toEqual([]);
  });

  test("reports zero usage for a plain-string answer and passes usage through otherwise", async () => {
    const { client } = createFakeClient();

    const plain = await answerOnce({
      answerFn: async () => "no usage reported",
      client,
      system: "s",
      messages,
      mode: "public",
    });
    expect(plain.usage).toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });

    const withUsage = await answerOnce({
      answerFn: async () => ({
        content: "counted",
        usage: { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 },
      }),
      client,
      system: "s",
      messages,
      mode: "public",
    });
    expect(withUsage).toEqual({
      content: "counted",
      usage: { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 },
    });
  });

  test("accepts a synchronous answerFn", async () => {
    const { client } = createFakeClient();

    const out = await answerOnce({
      answerFn: () => "sync brain",
      client,
      system: "s",
      messages,
      mode: "public",
    });

    expect(out.content).toBe("sync brain");
  });

  test("treats a brain that answers with nothing usable as an empty answer", async () => {
    const { client } = createFakeClient();

    for (const result of [undefined, null, { content: undefined }, { content: 42 }]) {
      const out = await answerOnce({
        answerFn: async () => result as never,
        client,
        system: "s",
        messages,
        mode: "public",
      });

      expect(out.content).toBe("");
    }
  });

  test("hands each caller its own usage object", async () => {
    const { client } = createFakeClient();
    const args = {
      answerFn: async () => "a",
      client,
      system: "s",
      messages,
      mode: "public",
    } as const;

    const first = await answerOnce(args);
    first.usage.total_tokens = 999;
    const second = await answerOnce(args);

    expect(second.usage.total_tokens).toBe(0);
  });

  test("scrubs credentials out of a brain's answer", async () => {
    const { client } = createFakeClient();

    const out = await answerOnce({
      answerFn: async () => "your key is sk-abcdefghijklmnopqrstuvwxyz",
      client,
      system: "s",
      messages,
      mode: "public",
    });

    expect(out.content).toBe("your key is [REDACTED]");
  });

  test("refuses a brain answer that leaks instructions", async () => {
    const { client } = createFakeClient();

    const out = await answerOnce({
      answerFn: async () => "Sure — here is my system prompt: be nice",
      client,
      system: "s",
      messages,
      mode: "public",
    });

    expect(out.content).toBe("Sorry, I can't share internal instructions. How else can I help?");
  });

  test("propagates a failing answerFn to the caller", async () => {
    const { client, calls } = createFakeClient();

    await expect(
      answerOnce({
        answerFn: async () => {
          throw new Error("brain unavailable");
        },
        client,
        system: "s",
        messages,
        mode: "public",
      }),
    ).rejects.toThrow("brain unavailable");
    // Failure is not silently papered over with the built-in completion.
    expect(calls).toEqual([]);
  });
});

describe("applyTransformReply", () => {
  test("passes the text through when no hook is configured", async () => {
    expect(await applyTransformReply(undefined, { channel: "c", text: "hi" })).toBe("hi");
  });

  test("a string result replaces the reply", async () => {
    const result = await applyTransformReply(() => "transformed", { channel: "c", text: "hi" });
    expect(result).toBe("transformed");
  });

  test("null vetoes the reply", async () => {
    const result = await applyTransformReply(() => null, { channel: "c", text: "hi" });
    expect(result).toBeNull();
  });

  test("a throw is logged and the original text is returned", async () => {
    const errors: unknown[][] = [];
    const result = await applyTransformReply(
      () => {
        throw new Error("plugin bug");
      },
      { channel: "c", text: "hi" },
      { error: (...args) => errors.push(args) },
    );
    expect(result).toBe("hi");
    expect(errors).toHaveLength(1);
  });

  // Same coercion `runAnswerFn` applies at its own plugin boundary: a hook
  // that doesn't conform to its declared `string | null` return (a missing
  // `return`, say) must not leak an arbitrary value past this function's own
  // declared return type.
  test("a non-string, non-null result is coerced to null (treated as a veto)", async () => {
    for (const bogus of [undefined, 42, { text: "hi" }]) {
      const result = await applyTransformReply(() => bogus as never, { channel: "c", text: "hi" });
      expect(result).toBeNull();
    }
  });
});

describe("answerStream", () => {
  test("streams the built-in completion when no answerFn is configured", async () => {
    const { client } = createFakeClient("Hello");

    const chunks = await collect(
      answerStream({ client, system: "s", messages, mode: "public", model: "gpt-4o-mini" }),
    );

    expect(chunks).toEqual(["Hello", " continued"]);
  });

  test("degrades a non-streaming brain to a single chunk", async () => {
    const { client, calls } = createFakeClient();

    const chunks = await collect(
      answerStream({
        answerFn: async () => "brain answer",
        client,
        system: "s",
        messages,
        mode: "public",
      }),
    );

    expect(chunks).toEqual(["brain answer"]);
    expect(calls).toEqual([]);
  });

  test("hands sender and conversationId to a streaming answerFn", async () => {
    const { client } = createFakeClient();
    const seen: AnswerFnInput[] = [];

    await collect(
      answerStream({
        answerFn: async (input) => {
          seen.push(input);
          return "brain answer";
        },
        client,
        system: "s",
        messages,
        mode: "public",
        sender: "+10000000000",
        conversationId: "conv-1",
      }),
    );

    expect(seen).toEqual([
      {
        system: "s",
        messages,
        mode: "public",
        sender: "+10000000000",
        conversationId: "conv-1",
      },
    ]);
  });

  test("yields nothing when the brain answers with an empty string", async () => {
    const { client } = createFakeClient();

    const chunks = await collect(
      answerStream({ answerFn: async () => "", client, system: "s", messages, mode: "public" }),
    );

    expect(chunks).toEqual([]);
  });

  test("guards streamed brain output too", async () => {
    const { client } = createFakeClient();

    const chunks = await collect(
      answerStream({
        answerFn: async () => ({ content: "token sk-abcdefghijklmnopqrstuvwxyz leaked" }),
        client,
        system: "s",
        messages,
        mode: "public",
      }),
    );

    expect(chunks).toEqual(["token [REDACTED] leaked"]);
  });

  test("propagates a failing answerFn from the stream", async () => {
    const { client } = createFakeClient();

    await expect(
      collect(
        answerStream({
          answerFn: async () => {
            throw new Error("brain unavailable");
          },
          client,
          system: "s",
          messages,
          mode: "public",
        }),
      ),
    ).rejects.toThrow("brain unavailable");
  });
});
