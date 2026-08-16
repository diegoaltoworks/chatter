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
// Channel SPI (the type ChatterConfig.channels is built from — the full
// toolkit, incl. gates and the sender registry, lives at the `./channels`
// subpath).
export type { Channel } from "./channels";
// Client types only — the widget classes themselves stay behind the
// `./client` subpath so importing core never bundles their runtime code.
export type {
  ChatBotConfig,
  ChatButtonConfig,
  ChatConfig,
  ChatMessage,
  ChatMode,
  StreamCallbacks,
} from "./client";
export type {
  AnswerFn,
  AnswerFnInput,
  AnswerFnResult,
  AnswerOptions,
  AnswerUsage,
  TransformReply,
  TransformReplyInput,
} from "./core/answer";
// Brain hook (answerFn-aware completion used by every chat surface)
export { answerOnce, answerStream, applyTransformReply } from "./core/answer";
export type { BucketsFor, BucketsForContext } from "./core/buckets";
// Retrieval bucket seam (role-gated knowledge, with the anonymous ceiling)
export { defaultBuckets, resolveBuckets } from "./core/buckets";
export { detectLeakage, guardOutput, scrubOutput } from "./core/guardrails";
export { completeOnce, completeStream, DEFAULT_MODEL } from "./core/llm";
export { loadKnowledge } from "./core/loaders";
export type { Logger, LogLevel } from "./core/logger";
// Logging seam (ChatterConfig.logger) — the default console logger, for
// hosts that want the same stderr-only behavior in their own code.
export { createConsoleLogger } from "./core/logger";
export type { NormalizedChatBody } from "./core/messages";
// Inbound message normalization (the server owns the system prompt: client
// system/tool turns never reach the pipeline)
export { normalizeChatBody, normalizeMessages } from "./core/messages";
export type {
  FallbackContext,
  FallbackFn,
  PipelineMessage,
  PipelineMode,
  PreparedChat,
  RerankContext,
  RerankContextArgs,
  RewriteQuery,
  RewriteQueryArgs,
} from "./core/pipeline";
// Chat pipeline (RAG without any UI or transport)
export { prepareChat } from "./core/pipeline";
export { DEFAULT_PROMPTS_DIR, PromptLoader } from "./core/prompts";
export type { Embedder, Retriever, VectorStoreOptions } from "./core/retrieval";
// Core modules (for advanced customization)
export { createOpenAIEmbedder, DEFAULT_KNOWLEDGE_DIR, VectorStore } from "./core/retrieval";
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
export { chatBodyLimit } from "./middleware/bodyLimit";
export { cors } from "./middleware/cors";
export { createJWTMiddleware, jwtSubject } from "./middleware/jwt";
export { createRateLimiter } from "./middleware/ratelimit";
export { createReferrerCheck } from "./middleware/referrer";
export { securityHeaders } from "./middleware/securityHeaders";
export { createSessionMiddleware } from "./middleware/session";
export { demoRoutes } from "./routes/demo";
// OpenAI-compatible route factory
export { openaiRoutes } from "./routes/openai";
export { privateRoutes } from "./routes/private";
// Route factories (for custom setup)
export { publicRoutes } from "./routes/public";
export type { ChatterApp } from "./server";
// Main server factory
export { createServer } from "./server";
export type { Shortener, ShortenerConfig } from "./shortener";
// Kutt-compatible URL shortener (config-injected; failures return the original URL)
export { createShortener } from "./shortener";
// Types
export type {
  BotBranding,
  BotChatConfig,
  BotIdentity,
  BrainHooks,
  ChatterConfig,
  CustomRoutes,
  EmbeddingChunk,
  KnowledgeDocument,
  PricingRates,
  ServerDependencies,
} from "./types";
