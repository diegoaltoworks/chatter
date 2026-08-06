/**
 * Chat pipeline — RAG prompt assembly, decoupled from any transport or UI.
 *
 * This is the single place where a conversation is turned into a
 * retrieval-augmented completion request. Every surface (widget routes,
 * OpenAI-compatible routes, MCP, programmatic use) should go through here
 * so behaviour stays identical regardless of how the chat is consumed.
 */

import type { PromptLoader } from "./prompts";
import type { VectorStore } from "./retrieval";

export type PipelineMode = "public" | "private";

export interface PipelineMessage {
  role: "user" | "assistant";
  content: string;
}

export interface PreparedChat {
  /** Fully assembled system prompt (rules + persona + retrieved context) */
  system: string;
  /** Conversation messages, unchanged */
  messages: PipelineMessage[];
}

const MODE_SETTINGS: Record<PipelineMode, { topK: number; label: string }> = {
  public: { topK: 6, label: "Context" },
  private: { topK: 8, label: "Internal Context" },
};

/**
 * Run retrieval for the latest user message and assemble the system prompt.
 *
 * @throws if the conversation contains no user message
 */
export async function prepareChat({
  store,
  prompts,
  mode,
  messages,
}: {
  store: VectorStore;
  prompts: PromptLoader;
  mode: PipelineMode;
  messages: PipelineMessage[];
}): Promise<PreparedChat> {
  const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUserMsg) {
    throw new Error("no user message found in conversation");
  }

  const { topK, label } = MODE_SETTINGS[mode];
  const ctx = await store.query(lastUserMsg.content, topK, ["base", mode]);
  const persona = mode === "private" ? prompts.privatePersona : prompts.publicPersona;
  const system = [prompts.baseSystemRules, persona, `${label}:\n${ctx.join("\n\n")}`].join("\n\n");

  return { system, messages };
}
