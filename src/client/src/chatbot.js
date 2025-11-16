/**
 * DiegoBot Client Library
 * A JavaScript client for consuming the DiegoBot API remotely
 */

class ChatBot {
  /**
   * @param {Object} config
   * @param {string} config.host - Host of the DiegoBot API (e.g., 'api.example.com' or 'example.com')
   * @param {string} config.mode - Either 'public' or 'staff'
   * @param {string} config.apiKey - API key for authentication
   * @param {string} [config.token] - Access token (required only for 'staff' mode)
   */
  constructor(config) {
    if (!config.host) {
      throw new Error("host is required");
    }
    if (!config.mode || !["public", "staff"].includes(config.mode)) {
      throw new Error('mode must be either "public" or "staff"');
    }
    if (!config.apiKey) {
      throw new Error("apiKey is required");
    }
    if (config.mode === "staff" && !config.token) {
      throw new Error("token is required for staff mode");
    }

    // Add https:// if not present and remove trailing slash
    let host = config.host.trim();
    if (!host.startsWith("http://") && !host.startsWith("https://")) {
      host = `https://${host}`;
    }
    this.baseUrl = host.replace(/\/$/, ""); // Remove trailing slash
    this.mode = config.mode;
    this.apiKey = config.apiKey;
    this.token = config.token;
    this.endpoint = `${this.baseUrl}/api/${this.mode}/chat`;
  }

  /**
   * Get authentication headers based on mode
   * @private
   */
  _getHeaders(streaming = false) {
    const headers = {
      "Content-Type": "application/json",
    };

    // Always send API key if provided (session key for both public and private)
    if (this.apiKey) {
      headers["x-api-key"] = this.apiKey;
    }

    // Send JWT token for private mode
    if (this.mode === "private" && this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }

    if (streaming) {
      headers.Accept = "text/event-stream";
    }

    return headers;
  }

  /**
   * Send a single message to the chatbot
   * @param {string} message - The message to send
   * @returns {Promise<string>} The bot's reply
   */
  async sendMessage(message) {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: this._getHeaders(),
      body: JSON.stringify({ message }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: "Unknown error" }));
      throw new Error(`API Error: ${error.error || response.statusText}`);
    }

    const data = await response.json();
    return data.reply;
  }

  /**
   * Send a conversation history (multi-turn chat)
   * @param {Array<{role: 'user'|'assistant', content: string}>} messages - Array of messages
   * @returns {Promise<string>} The bot's reply
   */
  async sendConversation(messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new Error("messages must be a non-empty array");
    }

    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: this._getHeaders(),
      body: JSON.stringify({ messages }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: "Unknown error" }));
      throw new Error(`API Error: ${error.error || response.statusText}`);
    }

    const data = await response.json();
    return data.reply;
  }

  /**
   * Stream a single message response
   * @param {string} message - The message to send
   * @param {Function} onChunk - Callback for each chunk (delta) received
   * @param {Function} [onEnd] - Optional callback when stream ends
   * @param {Function} [onError] - Optional callback for errors
   */
  async streamMessage(message, onChunk, onEnd, onError) {
    await this._stream({ message }, onChunk, onEnd, onError);
  }

  /**
   * Stream a conversation response
   * @param {Array<{role: 'user'|'assistant', content: string}>} messages - Array of messages
   * @param {Function} onChunk - Callback for each chunk (delta) received
   * @param {Function} [onEnd] - Optional callback when stream ends
   * @param {Function} [onError] - Optional callback for errors
   */
  async streamConversation(messages, onChunk, onEnd, onError) {
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new Error("messages must be a non-empty array");
    }
    await this._stream({ messages }, onChunk, onEnd, onError);
  }

  /**
   * Internal method to handle streaming
   * @private
   */
  async _stream(body, onChunk, onEnd, onError) {
    try {
      const response = await fetch(`${this.endpoint}?stream=1`, {
        method: "POST",
        headers: this._getHeaders(true),
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: "Unknown error" }));
        throw new Error(`API Error: ${error.error || response.statusText}`);
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
            } catch (_e) {
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
        onError(error);
      } else {
        throw error;
      }
    }
  }
}

// Export for different module systems
if (typeof module !== "undefined" && module.exports) {
  module.exports = ChatBot;
}
if (typeof window !== "undefined") {
  window.ChatBot = ChatBot;
}
