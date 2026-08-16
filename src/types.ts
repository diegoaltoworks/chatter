/**
 * Chatter Type Definitions
 *
 * Core types for the Chatter chatbot framework.
 * These types define the public API and configuration interface.
 */

import type { Client as LibsqlClient } from "@libsql/client";
import type { Hono } from "hono";
import type OpenAI from "openai";
import type { Channel, ChannelSenderRegistry } from "./channels";
import type { AnswerFn } from "./core/answer";
import type { BucketsFor } from "./core/buckets";
import type { Logger, LogLevel } from "./core/logger";
import type { PromptLoader } from "./core/prompts";
import type { VectorStore } from "./core/retrieval";

export type { Logger, LogLevel } from "./core/logger";

/**
 * USD price per 1M tokens, used to turn token usage into an estimated cost.
 * No built-in default: pricing varies by model and changes over time.
 */
export interface PricingRates {
  promptPer1M: number;
  completionPer1M: number;
}

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
  /** Static assets directory (chatter.js, chatter.css, etc.). Auto-detected if not specified */
  staticDir?: string;

  // OpenAI
  openai: {
    /** OpenAI API key */
    apiKey: string;
    /** Model to use. Default: gpt-4o */
    model?: string;
    /**
     * USD price per 1M prompt/completion tokens, used only to estimate cost
     * in MCP tool responses and logging. Optional because pricing varies by
     * model and changes over time; without it, cost estimates report token
     * counts only rather than guessing at a price.
     */
    pricing?: PricingRates;
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
    /** Secret for JWT API key creation/verification */
    secret?: string;
    /** Custom API key manager (advanced - for custom implementations) */
    apiKeyManager?: {
      verify: (token: string) => Promise<{ valid: boolean; payload?: unknown; error?: string }>;
    };
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
    /**
     * Enable OpenAI-compatible endpoints (/v1/chat/completions and
     * /api/private/v1/chat/completions) for third-party chat UIs and SDKs.
     * Default: true
     */
    enableOpenAICompat?: boolean;
    /**
     * Run fully headless: skip serving the built-in widget assets
     * (chatter.js/chatter.css) and all static/demo pages. API routes only.
     * Default: false
     */
    headless?: boolean;
  };

  // Rate limits
  rateLimit?: {
    /** Requests per minute for public endpoint. Default: 60 */
    public?: number;
    /** Requests per minute for private endpoint. Default: 120 */
    private?: number;
    /**
     * Trust the `X-Forwarded-For` header for per-IP rate-limit keying.
     * Only set this when Chatter sits behind a reverse proxy (nginx,
     * Cloudflare, a cloud load balancer) that overwrites client-supplied
     * XFF with the real socket address — otherwise a caller can rotate a
     * fake value per request and bypass limits entirely. When `false`,
     * every caller shares one bucket per limiter. Default: true.
     */
    trustProxy?: boolean;
    /**
     * API key values that identify a demo/public-showcase key and get a
     * stricter rate limit plus a referer/origin check (see
     * `requireReferrer`). Unset: no key is treated as a demo key.
     */
    demoApiKeys?: string[];
  };

  // Server
  server?: {
    /** Server port. Default: 8181 */
    port?: number;
    /** Enable CORS. Default: true */
    cors?: boolean;
    /**
     * Allowed origins for CORS and referrer checks.
     * Requests from these domains will be permitted.
     *
     * @example ["https://myapp.com", "https://staging.myapp.com"]
     *
     * When not set, defaults to `["*"]` (all origins allowed).
     */
    allowedOrigins?: string[];
    /**
     * Let demo routes (see `features.enableDemoRoutes`) accept any-port
     * `http(s)://localhost`/`127.0.0.1` in `Origin`/`Referer`, in addition to
     * `allowedOrigins`, for local development. `Origin`/`Referer` are only
     * enforced by browsers — a direct (non-browser) client can set either to
     * anything, so this is a convenience, not access control; leave it off
     * once `allowedOrigins` is configured for anything security-sensitive.
     * Default: false.
     */
    allowLocalhostDemo?: boolean;
    /**
     * Maximum accepted request body size in bytes, enforced on chat routes
     * (`/api/public/chat`, `/api/private/chat`, `/api/demo/chat`, and the
     * OpenAI-compatible `/v1/chat/completions` endpoints). Oversized bodies
     * are rejected with 413 before JSON parsing. `0` rejects every request
     * that has a body — it does not mean "unlimited". Default: 262144 (256
     * KiB) — generous for chat text, small enough to bound worst-case
     * parse/memory cost per request.
     */
    maxRequestBytes?: number;
    /**
     * `Content-Security-Policy` header value applied to every response.
     * Governs pages this server itself renders (demo pages, `chat.html`,
     * `private.html`) — it has no effect on a consumer's own site that only
     * embeds the widget script. The default allows `'unsafe-inline'` scripts
     * and styles (this repo's own example pages use inline `<script>`
     * blocks), so treat its presence as a baseline, not XSS-proof hardening.
     * Override this if your own static pages under `publicDir` load a script
     * from a CDN or other external host — the default's `script-src 'self'`
     * would block it. Default: `"default-src 'self'; script-src 'self'
     * 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:
     * https:; connect-src 'self' https:; frame-ancestors 'self'"`.
     */
    contentSecurityPolicy?: string;
    /**
     * `Strict-Transport-Security` header value, sent only when the request
     * arrived over HTTPS (or `NODE_ENV=production`). Set `false` to disable
     * HSTS entirely — e.g. if a subdomain your deployment doesn't control
     * shouldn't be pinned to HTTPS by `includeSubDomains`. Default:
     * `"max-age=15552000; includeSubDomains"` (180 days).
     */
    strictTransportSecurity?: string | false;
  };

  // Brain (advanced)
  /**
   * Replaces the completion call on every chat surface with your own brain —
   * an agent framework, a graph runtime, a remote service. Receives the
   * assembled system prompt and conversation from the pipeline and returns
   * the answer text (optionally with token usage).
   *
   * Retrieval, prompt assembly, auth, rate limiting, transports and output
   * guardrails all stay Chatter's. Errors surface as normal completion
   * errors. Unset: the built-in OpenAI completion is used.
   */
  answerFn?: AnswerFn;

  // Retrieval scope (advanced)
  /**
   * Decides which knowledge buckets each chat turn may retrieve from, given
   * the pipeline mode and — where the surface knows it — the sender's
   * identity. Use it for role-gated knowledge: entitle a signed-in operator
   * to buckets an anonymous visitor cannot see.
   *
   * Consulted by the chat routes, the OpenAI-compatible endpoints, the MCP
   * chat tools and the demo route. Return `undefined` to keep the mode
   * defaults (`base` plus the mode's own bucket). For a caller the surface
   * could not identify, the answer is filtered down to those same defaults —
   * the hook can narrow retrieval for an unnamed caller but never widen it.
   *
   * Unset: the mode defaults apply everywhere.
   */
  bucketsFor?: BucketsFor;

  // Custom routes (advanced)
  /** Custom route handler for advanced use cases. May be async — see {@link CustomRoutes} */
  customRoutes?: CustomRoutes;

  // Channels (advanced)
  /**
   * Transports (WhatsApp, or any future channel) to start alongside the
   * server. Each is started after routes are mounted with the same
   * {@link ServerDependencies} route factories receive; a channel that fails
   * to start is logged and skipped rather than crashing the server. See the
   * `./channels` subpath for the {@link Channel} SPI, the reply-decision
   * gates, and the sender registry channels register into.
   */
  channels?: Channel[];

  // Logging (advanced)
  /**
   * Structured logging seam for every library log call (auth/session
   * decisions, channel lifecycle, retrieval, flows, the scheduler). Unset: a
   * console-backed logger is used, writing to stderr only — stdout is never
   * touched, so the stdio MCP transport stays clean by default. Per-request
   * detail (e.g. auth/session decisions) logs at `debug`, which the default
   * logger suppresses; pass `logLevel: "debug"` (or a custom `logger`) to see it.
   */
  logger?: Logger;
  /** Minimum level the default console logger emits. Ignored when `logger` is set. Default: "info". */
  logLevel?: LogLevel;
}

/**
 * Mounts additional routes on the server's Hono app.
 *
 * May be synchronous or return a promise; `createServer` awaits it, so
 * asynchronous set-up (database migrations, plugin registries, anything the
 * routes depend on) is guaranteed to have finished before the server is handed
 * back and starts serving requests. A rejection fails startup rather than
 * leaving the app half-mounted.
 *
 * Declared as a union of two function types rather than one returning
 * `void | Promise<void>`: TypeScript only ignores a callback's return value
 * when the expected return type is exactly `void`, so the union keeps
 * expression-bodied mounts like `(app) => app.get(...)` — which return the
 * Hono app for chaining — assignable.
 */
export type CustomRoutes =
  | ((app: Hono, deps: ServerDependencies) => void)
  | ((app: Hono, deps: ServerDependencies) => Promise<void>);

/**
 * Dependencies passed to route factories and middleware
 */
export interface ServerDependencies {
  /** OpenAI client instance */
  client: OpenAI;
  /** Vector store instance */
  store: VectorStore;
  /**
   * The libsql database client, shared with the vector store. Custom routes
   * should use this handle rather than opening their own connection to the
   * same database.
   */
  db: LibsqlClient;
  /** Chatter configuration */
  config: ChatterConfig;
  /** Prompt loader instance */
  prompts: PromptLoader;
  /** API key manager instance (if configured) */
  apiKeyManager?: {
    verify: (token: string) => Promise<{ valid: boolean; payload?: unknown; error?: string }>;
  };
  /**
   * The channel sender registry every configured channel is started with.
   * A channel registers itself here (`deps.senders.register(channel.name, sender)`)
   * so custom routes and other channels can send outbound messages by
   * channel name without importing the transport.
   */
  senders: ChannelSenderRegistry;
  /** Resolved logger — `config.logger`, or the default console logger. */
  logger: Logger;
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
