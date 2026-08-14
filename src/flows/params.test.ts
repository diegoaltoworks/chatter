import { describe, expect, test } from "bun:test";
import type OpenAI from "openai";
import { extractParameters } from "./params";
import type { LoadedFlow } from "./types";

function makeFlow(): LoadedFlow {
  return {
    definition: {
      id: "booking",
      name: "Booking",
      description: "test flow",
      triggerKeywords: ["book"],
      schema: {
        type: "object",
        properties: {
          name: { type: "string", description: "name" },
          date: { type: "string", description: "date" },
        },
        required: ["name", "date"],
      },
    },
    handler: async () => ({ success: true, message: "ok" }),
    instructionsPath: `${import.meta.dir}/params.test.ts`,
  };
}

function fakeClient(content: string): OpenAI {
  return {
    chat: {
      completions: {
        create: async () => ({ choices: [{ message: { content } }] }),
      },
    },
  } as unknown as OpenAI;
}

describe("extractParameters", () => {
  test("merges newly extracted params with existing ones and reports incompleteness", async () => {
    const client = fakeClient(JSON.stringify({ extractedParams: { name: "Ada" } }));

    const result = await extractParameters(client, "gpt-4o-mini", makeFlow(), "I'm Ada", {});

    expect(result.extractedParams).toEqual({ name: "Ada" });
    expect(result.allParamsFilled).toBe(false);
    expect(result.nextPrompt).toContain("date");
  });

  test("reports completeness once every required field is present", async () => {
    const client = fakeClient(JSON.stringify({ extractedParams: { date: "2026-08-20" } }));

    const result = await extractParameters(client, "gpt-4o-mini", makeFlow(), "tomorrow", {
      name: "Ada",
    });

    expect(result.allParamsFilled).toBe(true);
    expect(result.nextPrompt).toBeUndefined();
  });

  test("drops a null-valued extracted param instead of treating the field as filled", async () => {
    const client = fakeClient(JSON.stringify({ extractedParams: { name: "Ada", date: null } }));

    const result = await extractParameters(client, "gpt-4o-mini", makeFlow(), "I'm Ada", {});

    expect(result.extractedParams).toEqual({ name: "Ada" });
    expect(result.allParamsFilled).toBe(false);
    expect(result.nextPrompt).toContain("date");
  });

  test("keeps re-prompting for a field the model repeatedly returns as null", async () => {
    const client = fakeClient(JSON.stringify({ extractedParams: { date: null } }));

    const result = await extractParameters(client, "gpt-4o-mini", makeFlow(), "not sure", {
      name: "Ada",
    });

    expect(result.extractedParams).toEqual({});
    expect(result.allParamsFilled).toBe(false);
    expect(result.nextPrompt).toContain("date");
  });

  test("uses the injected clock for date-relative prompt context instead of the real one", async () => {
    let capturedSystemPrompt = "";
    const client = {
      chat: {
        completions: {
          create: async (opts: { messages: Array<{ role: string; content: string }> }) => {
            capturedSystemPrompt = opts.messages[0]?.content ?? "";
            return { choices: [{ message: { content: JSON.stringify({ extractedParams: {} }) } }] };
          },
        },
      },
    } as unknown as OpenAI;

    const fixedNow = Date.UTC(2026, 0, 15);
    await extractParameters(client, "gpt-4o-mini", makeFlow(), "hi", {}, () => fixedNow);

    expect(capturedSystemPrompt).toContain("TODAY IS: 2026-01-15");
    expect(capturedSystemPrompt).toContain('"tomorrow" = 2026-01-16');
  });
});
