#!/usr/bin/env node
/**
 * Embedded in an Existing App
 *
 * The other server examples let chatter own the outermost Hono app. This one
 * shows the opposite direction: a host that already runs its own server
 * mounts chatter as a sub-app instead.
 *
 * Usage:
 *   1. Set environment variables: OPENAI_API_KEY, CHATTER_SECRET
 *   2. Run: bun run examples/embedded-in-existing-app.ts
 *   3. Server starts on http://localhost:8181
 *
 * Endpoints:
 *   - GET  /                       - the host's own route
 *   - GET  /chat/healthz           - chatter, mounted under /chat
 *   - GET  /chat/host-status       - a host route mounted onto chatter via customRoutes
 *   - POST /chat/api/public/chat   - chatter's public chat endpoint, now under /chat
 *   - POST /chat/v1/chat/completions - chatter's OpenAI-compatible endpoint, now under /chat
 */

import { Hono } from "hono";
import { type Channel, createServer, type Retriever } from "../src/index";

// The host's own app, with its own routes, unrelated to chatter.
const hostApp = new Hono();
hostApp.get("/", (c) => c.text("Welcome to My Company"));

// The host's own retrieval backend, standing in for whatever already
// indexes its content (a search service, a different vector store). Set
// `retriever` instead of `database` so chatter never opens a knowledge
// store of its own - see docs/patterns/adding-a-retriever.md.
const hostRetriever: Retriever = {
  async query(_query, _k, _allowedBuckets) {
    return [];
  },
};

// A minimal channel, configured through `channels` rather than started
// directly - `createServer` is the only supported way to start one, since
// it's the one place that assembles `ServerDependencies`.
const helloChannel: Channel = {
  name: "hello-channel",
  start(deps) {
    deps.logger.info("hello-channel started");
  },
  stop() {
    console.log("hello-channel stopped");
  },
};

async function main() {
  const chatter = await createServer({
    bot: {
      name: "MyCompanyBot",
      personName: "My Company",
      publicUrl: "https://bot.mycompany.com",
      description: "AI assistant mounted inside an existing app",
    },
    openai: {
      apiKey: process.env.OPENAI_API_KEY || "",
    },
    auth: {
      secret: process.env.CHATTER_SECRET || "",
    },
    // No `database` - the host's own retriever answers `prepareChat` instead.
    retriever: hostRetriever,
    // Skip serving chatter's own widget assets; the host serves its own UI.
    features: {
      headless: true,
    },
    channels: [helloChannel],
    // Mount one of the host's own routes onto chatter's app, alongside
    // mounting chatter onto the host's app below - composition works in
    // both directions.
    customRoutes: (app) => {
      app.get("/host-status", (c) => c.json({ ok: true }));
    },
  });

  // Mount chatter under the host's existing app rather than serving it
  // standalone. Chatter's CORS and security headers (config.server) apply
  // only to this mounted subtree - the host's own routes above get neither,
  // and chatter's default `Access-Control-Allow-Origin: *` is a second CORS
  // layer stacked on whatever the host's own app already does. Configure
  // `server.cors`/`server.allowedOrigins` if that default doesn't fit.
  hostApp.route("/chat", chatter);

  const port = 8181;
  Bun.serve({
    port,
    fetch: hostApp.fetch,
  });

  console.log(`Server running on http://localhost:${port}`);
  console.log(`  Host route:       http://localhost:${port}/`);
  console.log(`  Chatter:          http://localhost:${port}/chat/healthz`);
  console.log(`  Host-in-chatter:  http://localhost:${port}/chat/host-status`);
  console.log(`  Chatter chat API: http://localhost:${port}/chat/api/public/chat`);

  const shutdown = async () => {
    await chatter.stopChannels();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((error) => {
  console.error("Error starting server:", error);
  process.exit(1);
});
