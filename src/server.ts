/**
 * Chatter Server Factory
 *
 * Creates a configured Hono server instance with all routes and middleware.
 */

import { relative } from "node:path";
import { createClient } from "@libsql/client";
import { Hono } from "hono";
import OpenAI from "openai";
import { ApiKeyManager } from "./auth/apikeys";
import type { Channel } from "./channels";
import { createSenderRegistry } from "./channels";
import { PromptLoader } from "./core/prompts";
import { VectorStore } from "./core/retrieval";
import { loadServeStatic, type ServeStaticFn } from "./core/serve-static";
import { resolveStatic } from "./core/widgets";
import { cors } from "./middleware/cors";
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
  console.log(`🚀 Starting ${config.bot.name}...`);

  // Set defaults
  const knowledgeDir = config.knowledgeDir || "./config/knowledge";
  const promptsDir = config.promptsDir || "./config/prompts";
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

  // Open the single database connection shared by the vector store, the route
  // factories and anything mounted through customRoutes or channels.
  const db = createClient({
    url: config.database.url,
    authToken: config.database.authToken,
  });

  // Build vector store
  const store = new VectorStore(client, {
    databaseClient: db,
    knowledgeDir,
  });
  await store.build();
  console.log("✅ Knowledge base ready");

  // Create prompt loader
  const prompts = new PromptLoader(promptsDir, config.bot);

  // Initialize API key manager if configured
  let apiKeyManager: ApiKeyManager | undefined;
  const secret = config.auth?.secret || process.env.CHATTER_SECRET;
  if (secret) {
    apiKeyManager = new ApiKeyManager(secret);
    console.log("✅ API key manager initialized");
  } else if (config.auth?.apiKeyManager) {
    // Use custom manager if provided
    apiKeyManager = config.auth.apiKeyManager as ApiKeyManager;
    console.log("✅ Custom API key manager configured");
  }

  // Create Hono app
  const app = new Hono();

  // Apply CORS
  if (config.server?.cors !== false) {
    app.use("*", cors(config.server?.allowedOrigins));
  }

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
      console.error(`❌ Static assets disabled: ${(error as Error).message}`);
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
  const senders = createSenderRegistry();
  const deps: ServerDependencies = { client, store, db, config, prompts, apiKeyManager, senders };

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
        console.log(`✅ Channel "${channel.name}" started`);
      } catch (error) {
        console.error(`❌ Channel "${channel.name}" failed to start:`, error);
      }
    }
  }

  console.log(`✅ ${config.bot.name} server ready`);

  return Object.assign(app, {
    // Scoped to this call's started channels, not global — two servers in
    // one process each stop only their own. A channel's `stop()` throwing
    // (sync or async) is caught per-channel so one misbehaving channel can't
    // stop the rest from cleaning up.
    stopChannels: async (): Promise<void> => {
      await Promise.allSettled(
        started.map(async (channel) => {
          try {
            await channel.stop?.();
          } catch (error) {
            console.error(`Channel "${channel.name}" failed to stop:`, error);
          }
        }),
      );
    },
  });
}
