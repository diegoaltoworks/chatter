/**
 * Logging for MCP Server
 */

import { scrubOutput } from "../core/guardrails";
import { createConsoleLogger, type Logger } from "../core/logger";
import { lastUserMessage } from "../core/messages";
import type { ChatMessage, CostInfo, MCPLogCallback } from "./types";

/**
 * Logger for MCP chat interactions
 *
 * What a tool call *said* and what it *cost* are separated on purpose. The
 * console line is on by default, so it carries metadata only (tool, ids,
 * sizes, timings, tokens) and never the conversation, the retrieved context
 * or the answer. Content is emitted only when a host opts in with
 * `logging.content`, and then at `debug`, so the default log level keeps it
 * off even after the opt-in. Whatever does get emitted - console line or
 * `onChat` callback - is scrubbed of credentials first.
 */
export class MCPLogger {
  private enableConsole: boolean;
  private callback?: MCPLogCallback;
  private logger: Logger;
  private logContent: boolean;

  constructor(
    enableConsole = true,
    callback?: MCPLogCallback,
    logger?: Logger,
    logContent = false,
  ) {
    this.enableConsole = enableConsole;
    this.callback = callback;
    this.logger = logger ?? createConsoleLogger();
    this.logContent = logContent;
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

    const content = {
      userMessage: scrubOutput(lastUserMsg?.content || ""),
      conversationHistory: conversationMessages.map((msg) => ({
        ...msg,
        content: scrubOutput(msg.content),
      })),
      ragContext: ragContext.map(scrubOutput),
      response: scrubOutput(response),
    };

    const timestamp = new Date().toISOString();

    const logEvent = {
      timestamp,
      toolName,
      conversationId,
      ...content,
      duration,
      cost,
    };

    // Via the injected logger, never raw stdout - the stdio MCP transport's
    // JSON-RPC stream would otherwise be corrupted.
    if (this.enableConsole) {
      this.logger.info(
        JSON.stringify({
          event: "mcp_chat",
          timestamp,
          toolName,
          conversationId,
          messageCount: conversationMessages.length,
          ragContextCount: ragContext.length,
          responseChars: response.length,
          duration,
          cost,
        }),
      );

      if (this.logContent) {
        this.logger.debug(
          JSON.stringify({
            event: "mcp_chat_content",
            timestamp,
            toolName,
            conversationId,
            ...content,
          }),
        );
      }
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
 * @param logContent - Also emit conversation content, at `debug`. Default: false.
 * @returns MCPLogger instance
 */
export function createLogger(
  enableConsole = true,
  callback?: MCPLogCallback,
  logger?: Logger,
  logContent = false,
): MCPLogger {
  return new MCPLogger(enableConsole, callback, logger, logContent);
}
