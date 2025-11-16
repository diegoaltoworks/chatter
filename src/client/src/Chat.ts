/**
 * Chat UI Component
 * Renders a chat window interface
 */

import { ChatBot } from "./ChatBot";
import type { ChatConfig, ChatMessage } from "./types";

export class Chat {
  private bot: ChatBot;
  private container: HTMLElement;
  private messages: ChatMessage[] = [];
  private placeholder: string;
  private title: string;
  private subtitle: string;
  private onClose?: () => void;

  private messagesContainer!: HTMLElement;
  private inputElement!: HTMLTextAreaElement;
  private sendButton!: HTMLButtonElement;

  constructor(config: ChatConfig) {
    // Initialize bot
    this.bot = new ChatBot({
      host: config.host,
      mode: config.mode,
      apiKey: config.apiKey,
      token: config.token,
    });

    // Get or create container
    if (typeof config.container === "string") {
      const el = document.querySelector(config.container);
      if (!el) {
        throw new Error(`Container element not found: ${config.container}`);
      }
      this.container = el as HTMLElement;
    } else {
      this.container = config.container;
    }

    this.placeholder = config.placeholder || "Type your message...";
    this.title = config.title || "Chat";
    this.subtitle = config.subtitle || "";
    this.messages = config.initialMessages || [];
    this.onClose = config.onClose;

    this.render();
    this.attachEventListeners();
  }

  private render(): void {
    this.container.innerHTML = `<div class="chatter-ui-chat"><div class="chatter-ui-chat-header"><button class="chatter-ui-chat-close" type="button" aria-label="Close chat">×</button><div class="chatter-ui-chat-title">${this.title}</div>${this.subtitle ? `<div class="chatter-ui-chat-subtitle">${this.subtitle}</div>` : ""}</div><div class="chatter-ui-chat-messages"></div><div class="chatter-ui-chat-input-container"><textarea class="chatter-ui-chat-input" placeholder="${this.placeholder}" rows="1"></textarea><button class="chatter-ui-chat-send" type="button"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg></button></div></div>`;

    const messagesContainer = this.container.querySelector(".chatter-ui-chat-messages");
    const inputElement = this.container.querySelector(".chatter-ui-chat-input");
    const sendButton = this.container.querySelector(".chatter-ui-chat-send");

    if (!messagesContainer || !inputElement || !sendButton) {
      throw new Error("Required chat elements not found in container");
    }

    this.messagesContainer = messagesContainer as HTMLDivElement;
    this.inputElement = inputElement as HTMLTextAreaElement;
    this.sendButton = sendButton as HTMLButtonElement;

    // Render initial messages
    for (const msg of this.messages) {
      this.addMessageToUI(msg);
    }
  }

  private attachEventListeners(): void {
    // Close button click (mobile)
    const closeButton = this.container.querySelector(".chatter-ui-chat-close");
    if (closeButton && this.onClose) {
      closeButton.addEventListener("click", () => {
        this.onClose?.();
      });
    }

    // Send button click
    this.sendButton.addEventListener("click", () => this.handleSend());

    // Enter to send (Shift+Enter for new line)
    this.inputElement.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.handleSend();
      }
    });

    // Auto-resize textarea
    this.inputElement.addEventListener("input", () => {
      this.inputElement.style.height = "auto";
      this.inputElement.style.height = `${Math.min(this.inputElement.scrollHeight, 120)}px`;
    });

    // Ensure input stays in view when focused on mobile
    if (this.isMobile()) {
      this.inputElement.addEventListener("focus", () => {
        // Small delay to allow keyboard to appear
        setTimeout(() => {
          this.inputElement.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }, 300);
      });

      // Prevent double-tap zoom on send button
      this.sendButton.addEventListener(
        "touchend",
        (e) => {
          e.preventDefault();
          this.handleSend();
        },
        { passive: false },
      );
    }
  }

  private async handleSend(): Promise<void> {
    const message = this.inputElement.value.trim();
    if (!message) return;

    // Add user message
    const userMessage: ChatMessage = { role: "user", content: message };
    this.messages.push(userMessage);
    this.addMessageToUI(userMessage);

    // Clear input
    this.inputElement.value = "";
    this.inputElement.style.height = "auto";

    // Disable input while processing
    this.setInputEnabled(false);

    try {
      // Create assistant message placeholder
      const assistantMessage: ChatMessage = { role: "assistant", content: "" };
      this.messages.push(assistantMessage);
      const messageEl = this.addMessageToUI(assistantMessage);
      const contentEl = messageEl.querySelector(".chatter-ui-message-content");

      if (!contentEl) {
        throw new Error("Message content element not found");
      }

      // Stream response
      await this.bot.streamConversation(this.messages, {
        onChunk: (delta) => {
          assistantMessage.content += delta;
          contentEl.textContent = assistantMessage.content;
          this.scrollToBottom();
        },
        onEnd: () => {
          this.setInputEnabled(true);
          // Only auto-focus on desktop; on mobile, let user tap to focus
          // This prevents the keyboard from popping up unexpectedly
          if (!this.isMobile()) {
            this.inputElement.focus();
          }
        },
        onError: (error) => {
          console.error("Stream error:", error);
          assistantMessage.content = "Sorry, an error occurred. Please try again.";
          contentEl.textContent = assistantMessage.content;
          contentEl.classList.add("chatter-ui-message-error");
          this.setInputEnabled(true);
        },
      });
    } catch (error) {
      console.error("Send error:", error);
      const errorMessage: ChatMessage = {
        role: "assistant",
        content: "Sorry, an error occurred. Please try again.",
      };
      this.messages.push(errorMessage);
      const messageEl = this.addMessageToUI(errorMessage);
      messageEl
        .querySelector(".chatter-ui-message-content")
        ?.classList.add("chatter-ui-message-error");
      this.setInputEnabled(true);
    }
  }

  private addMessageToUI(message: ChatMessage): HTMLElement {
    const messageEl = document.createElement("div");
    messageEl.className = `chatter-ui-message chatter-ui-message-${message.role}`;
    messageEl.innerHTML = `<div class="chatter-ui-message-content">${message.content}</div>`;
    this.messagesContainer.appendChild(messageEl);
    this.scrollToBottom();
    return messageEl;
  }

  private setInputEnabled(enabled: boolean): void {
    this.inputElement.disabled = !enabled;
    this.sendButton.disabled = !enabled;
  }

  private scrollToBottom(): void {
    this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
  }

  /**
   * Clear all messages
   */
  clear(): void {
    this.messages = [];
    this.messagesContainer.innerHTML = "";
  }

  /**
   * Get current conversation
   */
  getMessages(): ChatMessage[] {
    return [...this.messages];
  }

  /**
   * Destroy the chat instance
   */
  destroy(): void {
    this.container.innerHTML = "";
  }

  /**
   * Detect if the device is mobile based on screen width
   */
  private isMobile(): boolean {
    return window.innerWidth <= 768;
  }
}
