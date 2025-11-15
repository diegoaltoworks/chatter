/**
 * Chatter Type Definitions
 *
 * Core types for the Chatter chatbot framework.
 * These types define the public API and configuration interface.
 */

import type { Hono } from "hono";
import type OpenAI from "openai";
import type { PromptLoader } from "./core/prompts";
import type { VectorStore } from "./core/retrieval";

/**
 * Bot identity configuration
 */
export interface BotIdentity {
  /** Bot display name (e.g., "DiegoBot", "AcmeBot") */
  name: string;
  /** Person or company name the bot represents */
  personName: string;
  /** Public URL where the bot is deployed */
  publicUrl: string;
  /** Brief description of the bot's purpose */
  description: string;
}

/**
 * Bot branding configuration
 */
export interface BotBranding {
  /** Primary color for public chat widget */
  publicPrimaryColor?: string;
  /** Primary color for private chat widget */
  privatePrimaryColor?: string;
}

/**
 * Bot chat UI configuration
 */
export interface BotChatConfig {
  /** Title for public chat widget */
  publicTitle?: string;
  /** Subtitle for public chat widget */
  publicSubtitle?: string;
  /** Title for private chat widget */
  privateTitle?: string;
  /** Subtitle for private chat widget */
  privateSubtitle?: string;
}

/**
 * Main configuration for Chatter server
 */
export interface ChatterConfig {
  // Bot identity
  bot: BotIdentity;
  branding?: BotBranding;
  chat?: BotChatConfig;

  // Paths
  /** Base config directory. Default: ./config */
  configDir?: string;
  /** Knowledge base directory. Default: ./config/knowledge */
  knowledgeDir?: string;
  /** Prompts directory. Default: ./config/prompts */
  promptsDir?: string;
  /** Public static files directory. Default: ./public */
  publicDir?: string;

  // OpenAI
  openai: {
    /** OpenAI API key */
    apiKey: string;
    /** Model to use. Default: gpt-4-turbo */
    model?: string;
  };

  // Database
  database: {
    /** Turso database URL */
    url: string;
    /** Turso auth token */
    authToken: string;
  };

  // Auth
  auth?: {
    /** API key for public endpoint (optional) */
    publicApiKey?: string;
    /** JWT configuration for private endpoint */
    jwt?: {
      /** JWKS URL for JWT verification */
      jwksUrl?: string;
      /** Expected JWT issuer */
      issuer?: string;
      /** Expected JWT audience */
      audience?: string;
      /** Public key PEM (alternative to JWKS) */
      publicKeyPem?: string;
    };
    /** Clerk configuration */
    clerk?: {
      /** Clerk publishable key */
      publishableKey?: string;
      /** Clerk frontend API URL */
      frontendUrl?: string;
    };
  };

  // Features
  features?: {
    /** Enable public chat endpoint. Default: true */
    enablePublicChat?: boolean;
    /** Enable private chat endpoint. Default: true */
    enablePrivateChat?: boolean;
    /** Enable demo routes (/demo/*). Default: false */
    enableDemoRoutes?: boolean;
  };

  // Rate limits
  rateLimit?: {
    /** Requests per minute for public endpoint. Default: 60 */
    public?: number;
    /** Requests per minute for private endpoint. Default: 120 */
    private?: number;
  };

  // Server
  server?: {
    /** Server port. Default: 8181 */
    port?: number;
    /** Enable CORS. Default: true */
    cors?: boolean;
  };

  // Custom routes (advanced)
  /** Custom route handler for advanced use cases */
  customRoutes?: (app: Hono, deps: ServerDependencies) => void;
}

/**
 * Dependencies passed to route factories and middleware
 */
export interface ServerDependencies {
  /** OpenAI client instance */
  client: OpenAI;
  /** Vector store instance */
  store: VectorStore;
  /** Chatter configuration */
  config: ChatterConfig;
  /** Prompt loader instance */
  prompts: PromptLoader;
}

/**
 * Knowledge document
 */
export interface KnowledgeDocument {
  /** File path */
  path: string;
  /** Document content */
  content: string;
  /** Document metadata */
  metadata: {
    /** Source file path */
    source: string;
    /** Knowledge mode (public/private/base) */
    mode?: "public" | "private" | "base";
    /** Last modified timestamp */
    lastModified?: number;
  };
}

/**
 * Embedding chunk
 */
export interface EmbeddingChunk {
  /** Chunk content */
  content: string;
  /** Embedding vector */
  embedding: number[];
  /** Chunk metadata */
  metadata: {
    /** Source file path */
    source: string;
    /** Knowledge mode */
    mode?: "public" | "private" | "base";
    /** Chunk index in document */
    chunk_index: number;
  };
}
