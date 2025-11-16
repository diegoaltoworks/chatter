/**
 * Chatter Server Factory
 *
 * Creates a configured Hono server instance with all routes and middleware.
 */

import { join } from "node:path";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import OpenAI from "openai";
import { ApiKeyManager } from "./auth/apikeys";
import { PromptLoader } from "./core/prompts";
import { VectorStore } from "./core/retrieval";
import { resolveStatic } from "./core/widgets";
import { cors } from "./middleware/cors";
import { demoRoutes } from "./routes/demo";
import { privateRoutes } from "./routes/private";
import { publicRoutes } from "./routes/public";
import type { ChatterConfig } from "./types";

/**
 * Create a Chatter server instance
 *
 * @param config - Chatter configuration
 * @returns Configured Hono app instance
 */
export async function createServer(config: ChatterConfig) {
  console.log(`🚀 Starting ${config.bot.name}...`);

  // Set defaults
  const knowledgeDir = config.knowledgeDir || "./config/knowledge";
  const promptsDir = config.promptsDir || "./config/prompts";
  const publicDir = config.publicDir || "./public";
  const enablePublic = config.features?.enablePublicChat !== false;
  const enablePrivate = config.features?.enablePrivateChat !== false;
  const enableDemo = config.features?.enableDemoRoutes || false;

  // Resolve static assets directory
  const { staticDir } = resolveStatic(config.staticDir);

  // Initialize OpenAI
  const client = new OpenAI({
    apiKey: config.openai.apiKey,
  });

  // Build vector store
  const store = new VectorStore(client, {
    databaseUrl: config.database.url,
    databaseAuthToken: config.database.authToken,
    knowledgeDir,
  });
  await store.build();
  console.log("✅ Knowledge base ready");

  // Create prompt loader
  const prompts = new PromptLoader(promptsDir, config.bot);

  // Initialize API key manager if configured
  let apiKeyManager: ApiKeyManager | undefined;
  const secret = process.env.CHATTER_SECRET || config.auth?.secret;
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
    app.use("*", cors());
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

  // Serve static assets (chatter.js, chatter.css)
  if (staticDir) {
    const relativePath = require("node:path").relative(process.cwd(), staticDir);
    app.get("/chatter.js", serveStatic({ path: `${relativePath}/chatter.js` }));
    app.get("/chatter.css", serveStatic({ path: `${relativePath}/chatter.css` }));
  }

  // Serve static files from public directory
  if (publicDir) {
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

  // Build dependencies for routes
  const deps = { client, store, config, prompts, apiKeyManager };

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

  // Custom routes
  if (config.customRoutes) {
    config.customRoutes(app, deps);
  }

  console.log(`✅ ${config.bot.name} server ready`);

  return app;
}
