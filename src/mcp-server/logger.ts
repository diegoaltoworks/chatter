/**
 * Logging for MCP Server
 */

import type { ChatMessage, CostInfo, MCPLogCallback } from "./types";

/**
 * Logger for MCP chat interactions
 */
export class MCPLogger {
  private enableConsole: boolean;
  private callback?: MCPLogCallback;

  constructor(enableConsole = true, callback?: MCPLogCallback) {
    this.enableConsole = enableConsole;
    this.callback = callback;
  }

  /**
   * Log a chat interaction
   */
  async logChatInteraction(
    toolName: string,
    conversationId: string,
    conversationMessages: ChatMessage[],
    ragContext: string[],
    response: string,
    duration: number,
    cost: CostInfo,
  ): Promise<void> {
    const lastUserMsg = [...conversationMessages].reverse().find((m) => m.role === "user");

    const logEvent = {
      timestamp: new Date().toISOString(),
      toolName,
      conversationId,
      userMessage: lastUserMsg?.content || "",
      conversationHistory: conversationMessages,
      ragContext,
      response,
      duration,
      cost,
    };

    // Console logging
    if (this.enableConsole) {
      console.log(
        JSON.stringify({
          event: "mcp_chat",
          ...logEvent,
        }),
      );
    }

    // Custom callback
    if (this.callback) {
      try {
        await this.callback(logEvent);
      } catch (err) {
        console.error("Logging callback error:", err);
      }
    }
  }
}

/**
 * Create a logger instance
 *
 * @param enableConsole - Enable console logging
 * @param callback - Custom logging callback
 * @returns MCPLogger instance
 */
export function createLogger(enableConsole = true, callback?: MCPLogCallback): MCPLogger {
  return new MCPLogger(enableConsole, callback);
}
