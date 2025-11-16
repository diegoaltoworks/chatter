import type OpenAI from "openai";
import { detectLeakage, scrubOutput } from "./guardrails";

export async function completeOnce({
  client,
  system,
  messages,
  temperature = 0.2,
}: {
  client: OpenAI;
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
  temperature?: number;
}) {
  const res = await client.chat.completions.create({
    model: "gpt-4o",
    temperature,
    messages: [{ role: "system", content: system }, ...messages],
  });
  let text = res.choices[0]?.message?.content ?? "";
  if (detectLeakage(text))
    text = "Sorry, I can't share internal instructions. How else can I help?";
  return { content: scrubOutput(text) };
}

// Server-Sent Events (optional)
export async function* completeStream({
  client,
  system,
  messages,
  temperature = 0.2,
}: {
  client: OpenAI;
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
  temperature?: number;
}) {
  const stream = await client.chat.completions.create({
    model: "gpt-4o",
    temperature,
    stream: true,
    messages: [{ role: "system", content: system }, ...messages],
  });

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content ?? "";
    if (delta) yield scrubOutput(delta);
  }
}
