/**
 * Logging for MCP Server
 */

import { createConsoleLogger, type Logger } from "../core/logger";
import { lastUserMessage } from "../core/messages";
import type { ChatMessage, CostInfo, MCPLogCallback } from "./types";

/**
 * Logger for MCP chat interactions
 */
export class MCPLogger {
  private enableConsole: boolean;
  private callback?: MCPLogCallback;
  private logger: Logger;

  constructor(enableConsole = true, callback?: MCPLogCallback, logger?: Logger) {
    this.enableConsole = enableConsole;
    this.callback = callback;
    this.logger = logger ?? createConsoleLogger();
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
    const lastUserMsg = lastUserMessage(conversationMessages);

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

    // Via the injected logger, never raw stdout - the stdio MCP transport's
    // JSON-RPC stream would otherwise be corrupted.
    if (this.enableConsole) {
      this.logger.info(
        JSON.stringify({
          event: "mcp_chat",
          ...logEvent,
        }),
      );
    }

    if (this.callback) {
      try {
        await this.callback(logEvent);
      } catch (err) {
        this.logger.error("Logging callback error:", err);
      }
    }
  }
}

/**
 * Create a logger instance
 *
 * @param enableConsole - Enable console logging
 * @param callback - Custom logging callback
 * @param logger - Logger implementation. Default: a console logger writing to stderr.
 * @returns MCPLogger instance
 */
export function createLogger(
  enableConsole = true,
  callback?: MCPLogCallback,
  logger?: Logger,
): MCPLogger {
  return new MCPLogger(enableConsole, callback, logger);
}
