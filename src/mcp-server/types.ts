/**
 * MCP Server Type Definitions
 */

import type { ChatterConfig } from "../types";

/**
 * MCP Server transport options
 */
export type MCPTransportMode = "stdio";

/**
 * Cost information for API usage
 */
export interface CostInfo {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCost: number; // in USD
}

/**
 * Logging callback for observability
 */
export type MCPLogCallback = (event: {
  timestamp: string;
  toolName: string;
  conversationId: string;
  userMessage: string;
  conversationHistory: Array<{ role: "user" | "assistant"; content: string }>;
  ragContext: string[];
  response: string;
  duration: number;
  cost: CostInfo;
}) => void | Promise<void>;

/**
 * Configuration for individual MCP tools
 */
export interface MCPToolConfig {
  /** Enable this tool. Default: true */
  enabled?: boolean;
  /** Tool name override. Defaults to chat_public/chat_private */
  name?: string;
  /** Tool description override */
  description?: string;
}

export interface MCPServerOptions extends ChatterConfig {
  /** Transport mode. Default: stdio */
  transport?: MCPTransportMode;

  /** Configuration for MCP tools */
  tools?: {
    /** Public chat tool configuration */
    public?: MCPToolConfig;
    /** Private chat tool configuration */
    private?: MCPToolConfig;
  };

  /** Logging and observability */
  logging?: {
    /** Enable console logging. Default: true */
    console?: boolean;
    /** Custom logging callback for external monitoring */
    onChat?: MCPLogCallback;
  };

  /** Rate limiting per tool (requests per minute). Default: no limit */
  toolRateLimit?: number;
}

/**
 * Chat message structure
 */
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Tool execution context
 */
export interface ToolContext {
  conversationId: string;
  conversationMessages: ChatMessage[];
  ragContext: string[];
  startTime: number;
}
