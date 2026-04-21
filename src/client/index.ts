/**
 * Client library entry point
 * Re-exports all client widgets and types
 */

export { Chat, ChatBot, ChatButton } from "./src";
export type {
  ChatBotConfig,
  ChatButtonConfig,
  ChatConfig,
  ChatMessage,
  ChatMode,
  StreamCallbacks,
} from "./src/types";
