/**
 * ChatBot API Client
 * A TypeScript client for consuming the DiegoBot API
 */

import type { ChatBotConfig, ChatMessage, ChatResponse, StreamCallbacks } from "./types";

export class ChatBot {
  private baseUrl: string;
  private mode: string;
  private apiKey: string;
  private token?: string;
  private endpoint: string;

  constructor(config: ChatBotConfig) {
    if (!config.host) {
      throw new Error("host is required");
    }
    if (!config.mode || !["public", "private"].includes(config.mode)) {
      throw new Error('mode must be either "public" or "private"');
    }
    if (!config.apiKey) {
      throw new Error("apiKey is required");
    }
    if (config.mode === "private" && !config.token) {
      throw new Error("token is required for private mode");
    }

    // Add protocol if not present (use http:// for localhost, https:// otherwise)
    let host = config.host.trim();
    if (!host.startsWith("http://") && !host.startsWith("https://")) {
      const isLocalhost = host.startsWith("localhost") || host.startsWith("127.0.0.1");
      const protocol = isLocalhost ? "http://" : "https://";
      host = `${protocol}${host}`;
    }
    this.baseUrl = host.replace(/\/$/, "");
    this.mode = config.mode;
    this.apiKey = config.apiKey;
    this.token = config.token;
    this.endpoint = `${this.baseUrl}/api/${this.mode}/chat`;
  }

  /**
   * Get authentication headers based on mode
   */
  private getHeaders(streaming = false): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (this.mode === "public") {
      headers["x-api-key"] = this.apiKey;
    } else if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }

    if (streaming) {
      headers.Accept = "text/event-stream";
    }

    return headers;
  }

  /**
   * Send a single message to the chatbot
   */
  async sendMessage(message: string): Promise<string> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify({ message }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: "Unknown error" }));
      throw new Error(`API Error: ${error.error || response.statusText}`);
    }

    const data: ChatResponse = await response.json();
    return data.reply;
  }

  /**
   * Send a conversation history (multi-turn chat)
   */
  async sendConversation(messages: ChatMessage[]): Promise<string> {
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new Error("messages must be a non-empty array");
    }

    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify({ messages }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: "Unknown error" }));
      throw new Error(`API Error: ${error.error || response.statusText}`);
    }

    const data: ChatResponse = await response.json();
    return data.reply;
  }

  /**
   * Stream a single message response
   */
  async streamMessage(message: string, callbacks: StreamCallbacks): Promise<void> {
    await this.stream({ message }, callbacks);
  }

  /**
   * Stream a conversation response
   */
  async streamConversation(messages: ChatMessage[], callbacks: StreamCallbacks): Promise<void> {
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new Error("messages must be a non-empty array");
    }
    await this.stream({ messages }, callbacks);
  }

  /**
   * Internal method to handle streaming
   */
  private async stream(
    body: { message?: string; messages?: ChatMessage[] },
    callbacks: StreamCallbacks,
  ): Promise<void> {
    const { onChunk, onEnd, onError } = callbacks;

    try {
      const response = await fetch(`${this.endpoint}?stream=1`, {
        method: "POST",
        headers: this.getHeaders(true),
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: "Unknown error" }));
        throw new Error(`API Error: ${error.error || response.statusText}`);
      }

      if (!response.body) {
        throw new Error("Response body is null");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6);
            try {
              const parsed = JSON.parse(data);
              if (parsed.delta) {
                onChunk(parsed.delta);
              }
            } catch {
              // Ignore parse errors for non-JSON lines
            }
          } else if (line.startsWith("event: end")) {
            if (onEnd) onEnd();
            return;
          }
        }
      }

      if (onEnd) onEnd();
    } catch (error) {
      if (onError) {
        onError(error as Error);
      } else {
        throw error;
      }
    }
  }
}
