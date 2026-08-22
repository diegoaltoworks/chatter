/**
 * Chatter Server Factory
 *
 * Creates a configured Hono server instance with all routes and middleware.
 */

import { relative } from "node:path";
import type { Client as LibsqlClient } from "@libsql/client";
import { Hono } from "hono";
import OpenAI from "openai";
import { ApiKeyManager } from "./auth/apikeys";
import type { Channel } from "./channels";
import { createSenderRegistry } from "./channels";
import type { KnowledgeHealthScheduler } from "./core/knowledgeHealth";
import { resolveLogger } from "./core/logger";
import { DEFAULT_PROMPTS_DIR, PromptLoader } from "./core/prompts";
import { DATABASE_CONFIG_REQUIRED_MESSAGE, type Retriever } from "./core/retrieval";
import { loadServeStatic, type ServeStaticFn } from "./core/serve-static";
import { resolveStatic } from "./core/widgets";
import { cors } from "./middleware/cors";
import { securityHeaders } from "./middleware/securityHeaders";
import { demoRoutes } from "./routes/demo";
import { openaiRoutes } from "./routes/openai";
import { privateRoutes } from "./routes/private";
import { publicRoutes } from "./routes/public";
import type { ChatterConfig, ServerDependencies } from "./types";

/**
 * A Chatter server: the Hono app plus a disposer for anything `createServer`
 * started outside the request/response cycle. Deliberately not a signal
 * handler — a library calling `process.exit` on a host's process would race
 * the host's own shutdown (e.g. an in-flight-request drain) and override its
 * exit code. Hosts that start channels wire `stopChannels` into their own
 * shutdown path:
 *
 * ```ts
 * const app = await createServer(config);
 * process.on("SIGTERM", async () => {
 *   await app.stopChannels();
 *   process.exit(0);
 * });
 * ```
 */
export type ChatterApp = Hono & { stopChannels: () => Promise<void> };

/**
 * Create a Chatter server instance
 *
 * @param config - Chatter configuration
 * @returns Configured Hono app instance, plus `stopChannels()` — see {@link ChatterApp}
 */
export async function createServer(config: ChatterConfig): Promise<ChatterApp> {
  const logger = resolveLogger(config.logger, config.logLevel);
  logger.info(`🚀 Starting ${config.bot.name}...`);

  // Set defaults
  const promptsDir = config.promptsDir || DEFAULT_PROMPTS_DIR;
  const publicDir = config.publicDir || "./public";
  const enablePublic = config.features?.enablePublicChat !== false;
  const enablePrivate = config.features?.enablePrivateChat !== false;
  const enableDemo = config.features?.enableDemoRoutes || false;
  const enableOpenAICompat = config.features?.enableOpenAICompat !== false;
  const headless = config.features?.headless === true;

  // Resolve static assets directory
  const { staticDir } = resolveStatic(config.staticDir);

  // Initialize OpenAI
  const client = new OpenAI({
    apiKey: config.openai.apiKey,
  });

  // Open the single database connection shared by the default vector store,
  // the route factories and anything mounted through customRoutes or
  // channels - only when something actually needs one. `@libsql/client` is
  // a required peer along this path alone: a host that supplies
  // `config.retriever` and never sets `config.database` never imports it, so
  // that host can install Chatter without libsql at all.
  let db: LibsqlClient | undefined;
  if (config.database) {
    const { openLibsqlClient } = await import("./core/retrieval");
    db = await openLibsqlClient(config.database);
  }

  // Build the retrieval backend: a caller-supplied Retriever (see
  // `config.retriever` in ./types), or the default VectorStore backed by
  // libsql + OpenAI embeddings.
  let store: Retriever;
  if (config.retriever) {
    store = config.retriever;
  } else {
    if (!db) {
      throw new Error(DATABASE_CONFIG_REQUIRED_MESSAGE);
    }
    const { DEFAULT_KNOWLEDGE_DIR, VectorStore, createOpenAIEmbedder } = await import(
      "./core/retrieval"
    );
    store = new VectorStore(createOpenAIEmbedder(client), {
      databaseClient: db,
      knowledgeDir: config.knowledgeDir || DEFAULT_KNOWLEDGE_DIR,
      logger,
    });
  }
  await store.build?.();
  logger.info("✅ Knowledge base ready");

  // Health checks query the `chunks`/`embeddings` schema `VectorStore` owns,
  // so they only make sense for the default store, not a caller-supplied
  // `config.retriever`.
  let knowledgeHealth: KnowledgeHealthScheduler | undefined;
  if (db && !config.retriever) {
    const { scheduleKnowledgeHealthChecks } = await import("./core/knowledgeHealth");
    knowledgeHealth = await scheduleKnowledgeHealthChecks({
      db,
      config: config.knowledgeHealthCheck,
      logger,
    });
  }

  // Create prompt loader
  const prompts = new PromptLoader(promptsDir, config.bot);

  // Initialize API key manager if configured
  let apiKeyManager: ApiKeyManager | undefined;
  const secret = config.auth?.secret || process.env.CHATTER_SECRET;
  if (secret) {
    apiKeyManager = new ApiKeyManager(secret);
    logger.info("✅ API key manager initialized");
  } else if (config.auth?.apiKeyManager) {
    // Use custom manager if provided
    apiKeyManager = config.auth.apiKeyManager as ApiKeyManager;
    logger.info("✅ Custom API key manager configured");
  }

  // Create Hono app
  const app = new Hono();

  // Apply CORS
  if (config.server?.cors !== false) {
    app.use("*", cors(config.server?.allowedOrigins));
  }

  // Baseline security headers (CSP, HSTS, nosniff) on every response
  app.use("*", securityHeaders(config));

  // Health check
  app.get("/healthz", (c) => c.text("ok"));

  // Config endpoint (safe public config)
  app.get("/config", (c) =>
    c.json({
      botName: config.bot.name,
      publicUrl: config.bot.publicUrl,
      clerkPublishableKey: config.auth?.clerk?.publishableKey || null,
      clerkFrontendUrl: config.auth?.clerk?.frontendUrl || null,
      branding: config.branding || {},
      chat: config.chat || {},
    }),
  );

  // Static files need a runtime-specific adapter (see ./core/serve-static), so
  // it is resolved once here and only when something will actually be served.
  // A runtime missing its adapter loses the static routes, not the whole
  // server — the API is what a headless-capable host is really booting.
  let serveStatic: ServeStaticFn | null = null;
  if (!headless && (staticDir || publicDir)) {
    try {
      serveStatic = await loadServeStatic();
    } catch (error) {
      logger.error(`❌ Static assets disabled: ${(error as Error).message}`);
    }
  }

  // Serve static assets (chatter.js, chatter.css)
  if (serveStatic && staticDir) {
    const relativePath = relative(process.cwd(), staticDir);
    app.get("/chatter.js", serveStatic({ path: `${relativePath}/chatter.js` }));
    app.get("/chatter.css", serveStatic({ path: `${relativePath}/chatter.css` }));
  }

  // Serve static files from public directory
  if (serveStatic && publicDir) {
    app.get("/", serveStatic({ path: `${publicDir}/index.html` }));
    app.get("/chat", serveStatic({ path: `${publicDir}/chat.html` }));
    app.get("/private", serveStatic({ path: `${publicDir}/private.html` }));
    app.get("/vanilla/chat", serveStatic({ path: `${publicDir}/vanilla/chat.html` }));

    // New demo pages (organized structure)
    app.get(
      "/demo/widget-button-public",
      serveStatic({ path: `${publicDir}/demo/widget-button-public.html` }),
    );
    app.get(
      "/demo/widget-button-private",
      serveStatic({ path: `${publicDir}/demo/widget-button-private.html` }),
    );
    app.get(
      "/demo/widget-inline-public",
      serveStatic({ path: `${publicDir}/demo/widget-inline-public.html` }),
    );
    app.get(
      "/demo/widget-inline-private",
      serveStatic({ path: `${publicDir}/demo/widget-inline-private.html` }),
    );
    app.get(
      "/demo/react-button-public",
      serveStatic({ path: `${publicDir}/demo/react-button-public.html` }),
    );
    app.get(
      "/demo/react-button-private",
      serveStatic({ path: `${publicDir}/demo/react-button-private.html` }),
    );
    app.get(
      "/demo/react-inline-public",
      serveStatic({ path: `${publicDir}/demo/react-inline-public.html` }),
    );
    app.get(
      "/demo/react-inline-private",
      serveStatic({ path: `${publicDir}/demo/react-inline-private.html` }),
    );

    // Legacy demo routes (for backwards compatibility)
    app.get("/demo/public", serveStatic({ path: `${publicDir}/demo-public.html` }));
    app.get("/demo/private", serveStatic({ path: `${publicDir}/demo-private.html` }));
    app.get("/demo/chatbot", serveStatic({ path: `${publicDir}/demo-chatbot.html` }));
    app.get("/demo/react", serveStatic({ path: `${publicDir}/react-demo.html` }));
  }

  // Build dependencies for routes. `senders` is the one instance channels
  // register into and brain-side features (a scheduler, the flows engine)
  // send through by channel name, without importing a transport.
  const senders = createSenderRegistry(logger);
  const deps: ServerDependencies = {
    client,
    store,
    // See ServerDependencies.db's doc comment: undefined here (cast to
    // satisfy the still-required type) exactly when config.database was
    // never set - i.e. a config.retriever host with nothing else needing db.
    db: db as LibsqlClient,
    config,
    prompts,
    apiKeyManager,
    senders,
    logger,
  };

  // Mount API routes
  if (enablePublic) {
    app.route("/", publicRoutes(deps));
  }

  if (enablePrivate) {
    app.route("/", privateRoutes(deps));
  }

  if (enableDemo) {
    app.route("/", demoRoutes(deps));
  }

  // OpenAI-compatible endpoints for third-party chat UIs and SDKs
  if (enableOpenAICompat) {
    app.route("/", openaiRoutes(deps));
  }

  // Custom routes. Awaited so async mounting (migrations, plugin registries)
  // is complete before the caller receives a server it can start serving with.
  if (config.customRoutes) {
    await config.customRoutes(app, deps);
  }

  // Channels start last, once routes and custom mounting are in place. A
  // channel that throws is logged and skipped rather than failing the whole
  // server — one broken transport must not take down the others or the API.
  const started: Channel[] = [];
  if (config.channels && config.channels.length > 0) {
    for (const channel of config.channels) {
      try {
        await channel.start(deps);
        started.push(channel);
        logger.info(`✅ Channel "${channel.name}" started`);
      } catch (error) {
        logger.error(`❌ Channel "${channel.name}" failed to start:`, error);
      }
    }
  }

  logger.info(`✅ ${config.bot.name} server ready`);

  return Object.assign(app, {
    // Scoped to this call's started channels, not global — two servers in
    // one process each stop only their own. A channel's `stop()` throwing
    // (sync or async) is caught per-channel so one misbehaving channel can't
    // stop the rest from cleaning up.
    stopChannels: async (): Promise<void> => {
      knowledgeHealth?.stop();
      await Promise.allSettled(
        started.map(async (channel) => {
          try {
            await channel.stop?.();
          } catch (error) {
            logger.error(`Channel "${channel.name}" failed to stop:`, error);
          }
        }),
      );
    },
  });
}
