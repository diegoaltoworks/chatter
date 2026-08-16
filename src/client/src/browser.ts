/**
 * Browser bundle entry point
 * Exposes all exports as global Chatter object
 */

import { Chat } from "./Chat";
import { ChatBot } from "./ChatBot";
import { ChatButton } from "./ChatButton";

declare global {
  interface Window {
    Chatter: {
      ChatBot: typeof ChatBot;
      Chat: typeof Chat;
      ChatButton: typeof ChatButton;
    };
  }
}

// Script-tag usage has no bundler to import from, so the browser build
// attaches itself to `window` instead.
if (typeof window !== "undefined") {
  window.Chatter = {
    ChatBot,
    Chat,
    ChatButton,
  };
}

export { Chat, ChatBot, ChatButton };
