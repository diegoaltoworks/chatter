/**
 * Chat pipeline — RAG prompt assembly, decoupled from any transport or UI.
 *
 * This is the single place where a conversation is turned into a
 * retrieval-augmented completion request. Every surface (widget routes,
 * OpenAI-compatible routes, MCP, programmatic use) should go through here
 * so behaviour stays identical regardless of how the chat is consumed, and
 * then ask for the answer via `answerOnce`/`answerStream` (see ./answer.ts)
 * so a caller-supplied brain is honoured.
 */

import type { PromptLoader } from "./prompts";
import type { VectorStore } from "./retrieval";

export type PipelineMode = "public" | "private";

export interface PipelineMessage {
  role: "user" | "assistant";
  content: string;
}

export interface PreparedChat {
  /** Fully assembled system prompt (see `prepareChat` for the layer order) */
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
 * The assembled system prompt is layered, in order:
 * base rules → persona → channel hint (optional) → retrieved context.
 *
 * `personaLayer` and `channelHint` let a caller shape those middle layers
 * without hand-rolling its own sandwich around `store`/`prompts`. Both are
 * optional, and blank (or whitespace-only) values are ignored: omit them and
 * the prompt is exactly what it has always been.
 *
 * @throws if the conversation contains no user message
 */
export async function prepareChat({
  store,
  prompts,
  mode,
  messages,
  personaLayer,
  channelHint,
}: {
  store: VectorStore;
  prompts: PromptLoader;
  mode: PipelineMode;
  messages: PipelineMessage[];
  /** Replaces the mode's persona from the loader when provided */
  personaLayer?: string;
  /** Extra system-prompt section describing the delivery channel */
  channelHint?: string;
}): Promise<PreparedChat> {
  const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUserMsg) {
    throw new Error("no user message found in conversation");
  }

  const { topK, label } = MODE_SETTINGS[mode];
  const ctx = await store.query(lastUserMsg.content, topK, ["base", mode]);
  const persona =
    personaLayer?.trim() || (mode === "private" ? prompts.privatePersona : prompts.publicPersona);
  const hint = channelHint?.trim();
  const system = [
    prompts.baseSystemRules,
    persona,
    ...(hint ? [hint] : []),
    `${label}:\n${ctx.join("\n\n")}`,
  ].join("\n\n");

  return { system, messages };
}
