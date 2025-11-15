/**
 * Client library entry point
 * Re-exports all client widgets and types
 */

export { ChatBot, Chat, ChatButton } from "./src";
export type {
  ChatBotConfig,
  ChatConfig,
  ChatButtonConfig,
  ChatMessage,
  ChatMode,
  StreamCallbacks,
} from "./src/types";
