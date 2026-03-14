#!/usr/bin/env node
/**
 * Basic HTTP Server Example
 *
 * This example shows how to create a basic Chatter HTTP server
 * with public and private chat endpoints.
 *
 * Usage:
 *   1. Set environment variables: OPENAI_API_KEY, TURSO_URL, TURSO_AUTH_TOKEN, CHATTER_SECRET
 *   2. Run: bun run examples/http-server-basic.ts
 *   3. Server starts on http://localhost:8181
 *
 * Endpoints:
 *   - GET  /healthz - Health check
 *   - GET  /config - Public configuration
 *   - POST /api/public/chat - Public chat (requires API key)
 *   - POST /api/private/chat - Private chat (requires JWT)
 */

import { createServer } from "../src/index";

async function main() {
  // Create the Chatter server
  const app = await createServer({
    bot: {
      name: "MyCompanyBot",
      personName: "My Company",
      publicUrl: "https://bot.mycompany.com",
      description: "AI assistant for customer support",
    },
    openai: {
      apiKey: process.env.OPENAI_API_KEY || "",
      model: "gpt-4o", // Optional: specify model
    },
    database: {
      url: process.env.TURSO_URL || "",
      authToken: process.env.TURSO_AUTH_TOKEN || "",
    },
    auth: {
      secret: process.env.CHATTER_SECRET || "",
    },
    knowledgeDir: "./knowledge",
    promptsDir: "./prompts",
    // Optional: Customize rate limits
    rateLimit: {
      public: 60, // 60 requests/minute for public
      private: 120, // 120 requests/minute for private
    },
  });

  // Start the server
  const port = 8181;
  Bun.serve({
    port,
    fetch: app.fetch,
  });

  console.log(`✅ Server running on http://localhost:${port}`);
  console.log(`   Health: http://localhost:${port}/healthz`);
  console.log(`   Config: http://localhost:${port}/config`);
}

main().catch((error) => {
  console.error("Error starting server:", error);
  process.exit(1);
});
