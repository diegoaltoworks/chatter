/**
 * Chatter - Embeddable AI Chatbot Framework
 *
 * This module provides a complete framework for building AI chatbots with:
 * - RAG (Retrieval-Augmented Generation) using OpenAI
 * - Public and private chat modes
 * - Embeddable widgets
 * - Rate limiting and authentication
 * - Knowledge base from markdown files
 *
 * @packageDocumentation
 */

export type { ApiKeyOptions, ApiKeyPayload, VerifyResult } from "./auth";
// Auth utilities
export { ApiKeyManager } from "./auth";
export type {
  ChatBotConfig,
  ChatButtonConfig,
  ChatConfig,
  ChatMessage,
  ChatMode,
  StreamCallbacks,
} from "./client";
// Client library (re-export from client subpackage)
export { Chat, ChatBot, ChatButton } from "./client";
export { detectLeakage, scrubOutput } from "./core/guardrails";
export { completeOnce, completeStream } from "./core/llm";
export { loadKnowledge } from "./core/loaders";
export { PromptLoader } from "./core/prompts";
// Core modules (for advanced customization)
export { VectorStore } from "./core/retrieval";
export {
  createSession,
  getActiveSessions,
  getSessionInfo,
  validateSession,
} from "./core/session";
export type { MCPServerOptions, MCPTransportMode } from "./mcp-server";
// MCP server factory
export { createMCPServer } from "./mcp-server";

// Middleware (for custom routes)
export { createAuthMiddleware } from "./middleware/auth";
export { cors } from "./middleware/cors";
export { createJWTMiddleware } from "./middleware/jwt";
export { createRateLimiter } from "./middleware/ratelimit";
export { createReferrerCheck } from "./middleware/referrer";
export { createSessionMiddleware } from "./middleware/session";
export { demoRoutes } from "./routes/demo";
export { privateRoutes } from "./routes/private";
// Route factories (for custom setup)
export { publicRoutes } from "./routes/public";
// Main server factory
export { createServer } from "./server";
// Types
export type {
  BotBranding,
  BotChatConfig,
  BotIdentity,
  ChatterConfig,
  EmbeddingChunk,
  KnowledgeDocument,
  ServerDependencies,
} from "./types";
