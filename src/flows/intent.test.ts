/**
 * Intent detection tests — a faked OpenAI client (see src/routes/openai.test.ts
 * for the same pattern), never a real API call.
 */

import { describe, expect, test } from "bun:test";
import type OpenAI from "openai";
import { detectIntent } from "./intent";
import type { LoadedFlow } from "./types";

function makeFlow(id: string): LoadedFlow {
  return {
    definition: {
      id,
      name: id,
      description: "test flow",
      triggerKeywords: [id],
      schema: { type: "object", properties: {}, required: [] },
    },
    handler: async () => ({ success: true, message: "ok" }),
    instructionsPath: `${import.meta.dir}/intent.test.ts`,
  };
}

function fakeClient(content: string): OpenAI {
  return {
    chat: {
      completions: {
        create: async () => ({
          choices: [{ message: { content } }],
        }),
      },
    },
  } as unknown as OpenAI;
}

describe("detectIntent", () => {
  test("returns the detected flow id when it is a known flow", async () => {
    const flows = new Map([["bookAppointment", makeFlow("bookAppointment")]]);
    const client = fakeClient(
      JSON.stringify({ intent: "bookAppointment", confidence: 0.92, reasoning: "matches" }),
    );

    const result = await detectIntent(client, "gpt-4o-mini", "I'd like to book", flows);

    expect(result).toEqual({ intent: "bookAppointment", confidence: 0.92, reasoning: "matches" });
  });

  test("normalizes an intent that isn't a loaded flow id to chatbot", async () => {
    const flows = new Map([["bookAppointment", makeFlow("bookAppointment")]]);
    const client = fakeClient(JSON.stringify({ intent: "somethingElse", confidence: 0.9 }));

    const result = await detectIntent(client, "gpt-4o-mini", "hello", flows);

    expect(result.intent).toBe("chatbot");
  });

  test("treats a non-numeric confidence as zero rather than string-coercing it", async () => {
    const flows = new Map([["bookAppointment", makeFlow("bookAppointment")]]);
    const client = fakeClient(JSON.stringify({ intent: "bookAppointment", confidence: "0.9" }));

    const result = await detectIntent(client, "gpt-4o-mini", "book it", flows);

    expect(result.confidence).toBe(0);
  });

  test("falls back to chatbot with zero confidence when the API call throws", async () => {
    const flows = new Map([["bookAppointment", makeFlow("bookAppointment")]]);
    const client = {
      chat: {
        completions: {
          create: async () => {
            throw new Error("network error");
          },
        },
      },
    } as unknown as OpenAI;

    const result = await detectIntent(client, "gpt-4o-mini", "hello", flows);

    expect(result).toEqual({
      intent: "chatbot",
      confidence: 0,
      reasoning: "exception, defaulting to chatbot",
    });
  });
});
