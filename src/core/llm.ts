import type OpenAI from "openai";
import { guardOutput, scrubOutput } from "./guardrails";

export const DEFAULT_MODEL = "gpt-4o";

export async function completeOnce({
  client,
  system,
  messages,
  temperature = 0.2,
  model = DEFAULT_MODEL,
  refusal,
}: {
  client: OpenAI;
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
  temperature?: number;
  model?: string;
  /** Wording for the guardrail refusal; falls back to `DEFAULT_REFUSAL`. */
  refusal?: string;
}) {
  const res = await client.chat.completions.create({
    model,
    temperature,
    messages: [{ role: "system", content: system }, ...messages],
  });
  const text = res.choices[0]?.message?.content ?? "";
  return {
    content: guardOutput(text, refusal),
    usage: res.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

// Server-Sent Events (optional)
export async function* completeStream({
  client,
  system,
  messages,
  temperature = 0.2,
  model = DEFAULT_MODEL,
}: {
  client: OpenAI;
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
  temperature?: number;
  model?: string;
}) {
  const stream = await client.chat.completions.create({
    model,
    temperature,
    stream: true,
    messages: [{ role: "system", content: system }, ...messages],
  });

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content ?? "";
    if (delta) yield scrubOutput(delta);
  }
}
