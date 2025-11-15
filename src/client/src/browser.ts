/**
 * Browser bundle entry point
 * Exposes all exports as global Fyne object
 */

import { Chat } from "./Chat";
import { ChatBot } from "./ChatBot";
import { ChatButton } from "./ChatButton";

// Extend window type
declare global {
  interface Window {
    Fyne: {
      ChatBot: typeof ChatBot;
      Chat: typeof Chat;
      ChatButton: typeof ChatButton;
    };
  }
}

// Expose to window for script tag usage
if (typeof window !== "undefined") {
  window.Fyne = {
    ChatBot,
    Chat,
    ChatButton,
  };
}

export { ChatBot, Chat, ChatButton };
