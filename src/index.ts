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

// Main server factory
export { createServer } from "./server";
export type { ChatterConfig, ServerDependencies } from "./types";

// Core modules (for advanced customization)
export { VectorStore } from "./core/retrieval";
export { completeOnce, completeStream } from "./core/llm";
export { loadKnowledge } from "./core/loaders";
export { PromptLoader } from "./core/prompts";
export { detectLeakage, scrubOutput } from "./core/guardrails";
export {
  createSession,
  validateSession,
  getSessionInfo,
  getActiveSessions,
} from "./core/session";

// Middleware (for custom routes)
export { createAuthMiddleware } from "./middleware/auth";
export { createJWTMiddleware } from "./middleware/jwt";
export { cors } from "./middleware/cors";
export { createRateLimiter } from "./middleware/ratelimit";
export { createReferrerCheck } from "./middleware/referrer";
export { createSessionMiddleware } from "./middleware/session";

// Route factories (for custom setup)
export { publicRoutes } from "./routes/public";
export { privateRoutes } from "./routes/private";
export { demoRoutes } from "./routes/demo";

// Client library (re-export from client subpackage)
export { ChatBot, Chat, ChatButton } from "./client";
export type {
  ChatBotConfig,
  ChatConfig,
  ChatButtonConfig,
  ChatMessage,
  ChatMode,
  StreamCallbacks,
} from "./client";

// Types
export type {
  BotIdentity,
  BotBranding,
  BotChatConfig,
  KnowledgeDocument,
  EmbeddingChunk,
} from "./types";
