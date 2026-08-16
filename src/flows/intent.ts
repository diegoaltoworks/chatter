/**
 * LLM-powered intent detection — classifies a message into a flow id, or the
 * `chatbot` fallback, using the caller's OpenAI client (never a raw fetch, so
 * the same client tests already fake for chat completions covers this too).
 */

import type OpenAI from "openai";
import { createConsoleLogger, type Logger } from "../core/logger";
import type { IntentDetection, LoadedFlow } from "./types";

/** Detects which loaded flow (if any) a message expresses intent for. */
export async function detectIntent(
  client: OpenAI,
  model: string,
  message: string,
  flows: Map<string, LoadedFlow>,
  conversationContext?: string[],
  logger: Logger = createConsoleLogger(),
): Promise<IntentDetection> {
  const contextStr =
    conversationContext && conversationContext.length > 0
      ? `\n\nRecent conversation:\n${conversationContext.join("\n")}`
      : "";

  const flowDescriptions = Array.from(flows.entries())
    .map(([id, flow], index) => {
      const keywords = flow.definition.triggerKeywords.join(", ");
      return `${index + 1}. ${id} -- ${flow.definition.description}\n   - Keywords: ${keywords}`;
    })
    .join("\n\n");

  const systemPrompt = `You are an intent detector.

Detect ONE category. Use these EXACT ids (they must match flow ids):

${flowDescriptions}

${flows.size + 1}. chatbot -- All other questions (general fallback)
${contextStr}

Return JSON with:
- "intent": one of the ids above (exact string)
- "confidence": 0.0-1.0 (how certain you are)
- "reasoning": brief explanation

Rules:
- If uncertain, always return "chatbot" with low confidence`;

  try {
    const response = await client.chat.completions.create({
      model,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: message },
      ],
    });

    const content = response.choices[0]?.message?.content || "{}";
    const raw = JSON.parse(content) as IntentDetection;

    const validFlowIds = new Set(flows.keys());
    const intent = validFlowIds.has(raw.intent) ? raw.intent : "chatbot";
    // Model output is untyped JSON; a non-numeric confidence must not satisfy
    // `>= minConfidence` via string coercion (e.g. "0.9" >= 0.7 is true).
    const confidence = typeof raw.confidence === "number" ? raw.confidence : 0;

    return { intent, confidence, reasoning: raw.reasoning };
  } catch (error) {
    logger.warn(
      `[flows] intent detection failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { intent: "chatbot", confidence: 0, reasoning: "exception, defaulting to chatbot" };
  }
}
