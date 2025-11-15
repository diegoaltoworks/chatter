/**
 * Browser bundle entry point
 * Exposes all exports as global Chatter object
 */

import { Chat } from "./Chat";
import { ChatBot } from "./ChatBot";
import { ChatButton } from "./ChatButton";

// Extend window type
declare global {
  interface Window {
    Chatter: {
      ChatBot: typeof ChatBot;
      Chat: typeof Chat;
      ChatButton: typeof ChatButton;
    };
  }
}

// Expose to window for script tag usage
if (typeof window !== "undefined") {
  window.Chatter = {
    ChatBot,
    Chat,
    ChatButton,
  };
}

export { ChatBot, Chat, ChatButton };
