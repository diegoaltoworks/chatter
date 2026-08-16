/**
 * Shared input parsing for MCP chat tools — both `chat_public` and
 * `chat_private` accept the same "single message or conversation" shape.
 */

import type { ChatMessage } from "./types";

/**
 * Resolve a tool's `message`/`messages` args into a conversation.
 *
 * @throws if neither is provided
 */
export function resolveConversationMessages(
  message: string | undefined,
  messages: ChatMessage[] | undefined,
): ChatMessage[] {
  if (messages) return messages;
  if (message) return [{ role: "user", content: message }];
  throw new Error("Either 'message' or 'messages' is required");
}
