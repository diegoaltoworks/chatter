/**
 * ChatButton Component
 * Renders a floating chat button with a popup chat window
 */

import { Chat } from "./Chat";
import type { ChatButtonConfig } from "./types";

export class ChatButton {
  private config: ChatButtonConfig;
  private buttonElement!: HTMLButtonElement;
  private chatContainer!: HTMLElement;
  private chat: Chat | null = null;
  private isOpen = false;

  constructor(config: ChatButtonConfig) {
    this.config = {
      position: "bottom-right",
      label: "💬",
      ...config,
    };

    this.render();
    this.attachEventListeners();
  }

  private render(): void {
    // Create button
    this.buttonElement = document.createElement("button");
    this.buttonElement.className = `fyne-chat-button fyne-chat-button-${this.config.position}`;
    this.buttonElement.innerHTML = this.config.label || "💬";
    this.buttonElement.setAttribute("aria-label", "Open chat");

    // Apply custom styles
    if (this.config.styles) {
      Object.assign(this.buttonElement.style, this.config.styles);
    }

    // Create chat container
    this.chatContainer = document.createElement("div");
    this.chatContainer.className = `fyne-chat-popup fyne-chat-popup-${this.config.position}`;
    this.chatContainer.style.display = "none";

    // Add to document
    document.body.appendChild(this.buttonElement);
    document.body.appendChild(this.chatContainer);
  }

  private attachEventListeners(): void {
    this.buttonElement.addEventListener("click", () => this.toggle());

    // Close on escape key
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.isOpen) {
        this.close();
      }
    });

    // Close when clicking outside
    document.addEventListener("click", (e) => {
      if (
        this.isOpen &&
        !this.chatContainer.contains(e.target as Node) &&
        !this.buttonElement.contains(e.target as Node)
      ) {
        this.close();
      }
    });
  }

  private toggle(): void {
    if (this.isOpen) {
      this.close();
    } else {
      this.open();
    }
  }

  open(): void {
    if (this.isOpen) return;

    // Create chat instance if not exists
    if (!this.chat) {
      this.chat = new Chat({
        host: this.config.host,
        mode: this.config.mode,
        apiKey: this.config.apiKey,
        token: this.config.token,
        container: this.chatContainer,
        onClose: () => this.close(),
        ...this.config.chatConfig,
      });
    }

    this.chatContainer.style.display = "block";
    this.buttonElement.classList.add("fyne-chat-button-open");
    this.buttonElement.setAttribute("aria-label", "Close chat");
    this.isOpen = true;

    // Prevent body scrolling on mobile when chat is open
    if (this.isMobile()) {
      document.body.style.overflow = "hidden";
      // Prevent iOS Safari bounce scrolling
      document.body.style.position = "fixed";
      document.body.style.width = "100%";
    }

    // Focus input with a longer delay for mobile devices
    // This ensures the popup animation completes and the DOM is fully ready
    setTimeout(
      () => {
        const input = this.chatContainer.querySelector(".fyne-chat-input") as HTMLTextAreaElement;
        if (input) {
          input.focus();
          // On mobile, scroll input into view after a brief delay to account for keyboard
          if (this.isMobile()) {
            setTimeout(() => {
              input.scrollIntoView({ behavior: "smooth", block: "center" });
            }, 300);
          }
        }
      },
      this.isMobile() ? 300 : 100,
    );
  }

  close(): void {
    if (!this.isOpen) return;

    this.chatContainer.style.display = "none";
    this.buttonElement.classList.remove("fyne-chat-button-open");
    this.buttonElement.setAttribute("aria-label", "Open chat");
    this.isOpen = false;

    // Restore body scrolling on mobile
    if (this.isMobile()) {
      document.body.style.overflow = "";
      document.body.style.position = "";
      document.body.style.width = "";
    }
  }

  /**
   * Detect if the device is mobile based on screen width
   */
  private isMobile(): boolean {
    return window.innerWidth <= 768;
  }

  /**
   * Destroy the chat button and cleanup
   */
  destroy(): void {
    this.chat?.destroy();
    this.buttonElement.remove();
    this.chatContainer.remove();
  }

  /**
   * Check if chat is open
   */
  isOpened(): boolean {
    return this.isOpen;
  }
}
