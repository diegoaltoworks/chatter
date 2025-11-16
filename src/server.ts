/**
 * Chatter Server Factory
 *
 * Creates a configured Hono server instance with all routes and middleware.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import OpenAI from "openai";
import { ApiKeyManager } from "./auth/apikeys";
import { PromptLoader } from "./core/prompts";
import { VectorStore } from "./core/retrieval";
import { cors } from "./middleware/cors";
import { demoRoutes } from "./routes/demo";
import { privateRoutes } from "./routes/private";
import { publicRoutes } from "./routes/public";
import type { ChatterConfig } from "./types";

// Resolve paths relative to this module
const moduleURL = import.meta.url;
const modulePath = fileURLToPath(moduleURL);
const moduleDir = dirname(modulePath);
const widgetsDir = join(moduleDir, "widgets");

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
  const secret = process.env.CHATBOT_SECRET || config.auth?.secret;
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

  // Serve static files from public directory
  if (publicDir) {
    app.get("/", serveStatic({ path: `${publicDir}/index.html` }));
    app.get("/chat", serveStatic({ path: `${publicDir}/chat.html` }));
    app.get("/private", serveStatic({ path: `${publicDir}/private.html` }));
    app.get("/vanilla/chat", serveStatic({ path: `${publicDir}/vanilla/chat.html` }));

    // Demo pages
    app.get("/demo/public", serveStatic({ path: `${publicDir}/demo-public.html` }));
    app.get("/demo/private", serveStatic({ path: `${publicDir}/demo-private.html` }));
    app.get("/demo/chatbot", serveStatic({ path: `${publicDir}/demo-chatbot.html` }));
    app.get("/demo/session", serveStatic({ path: `${publicDir}/demo-session.html` }));

    // Serve widget files from package dist (resolved relative to this module)
    app.get("/chatter.js", serveStatic({ path: join(widgetsDir, "chatter.js") }));
    app.get("/chatter.css", serveStatic({ path: join(widgetsDir, "chatter.css") }));
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
