#!/usr/bin/env node
/**
 * HTTP Server with Clerk Authentication
 *
 * This example shows how to integrate Clerk authentication
 * for the private chat endpoint.
 *
 * Usage:
 *   1. Set up Clerk account and get credentials
 *   2. Set environment variables:
 *      - OPENAI_API_KEY
 *      - TURSO_URL, TURSO_AUTH_TOKEN
 *      - CHATTER_SECRET
 *      - CLERK_PUBLISHABLE_KEY
 *      - CLERK_FRONTEND_URL
 *   3. Run: bun run examples/http-server-with-clerk.ts
 *
 * The private endpoint will validate Clerk JWT tokens.
 */

import { createServer } from "../src/index";

async function main() {
  const app = await createServer({
    bot: {
      name: "MyCompanyBot",
      personName: "My Company",
      publicUrl: "https://bot.mycompany.com",
      description: "AI assistant with authenticated access",
    },
    openai: {
      apiKey: process.env.OPENAI_API_KEY || "",
    },
    database: {
      url: process.env.TURSO_URL || "",
      authToken: process.env.TURSO_AUTH_TOKEN || "",
    },
    auth: {
      secret: process.env.CHATTER_SECRET || "",
      // Clerk configuration for private endpoint
      clerk: {
        publishableKey: process.env.CLERK_PUBLISHABLE_KEY || "",
        frontendUrl: process.env.CLERK_FRONTEND_URL || "",
      },
    },
    knowledgeDir: "./knowledge",
    promptsDir: "./prompts",
    branding: {
      publicPrimaryColor: "#4F46E5",
      privatePrimaryColor: "#7C3AED",
    },
    chat: {
      publicTitle: "Customer Support",
      publicSubtitle: "How can we help you?",
      privateTitle: "Internal Assistant",
      privateSubtitle: "Access company knowledge",
    },
  });

  const port = 8181;
  Bun.serve({ port, fetch: app.fetch });

  console.log(`✅ Server running on http://localhost:${port}`);
  console.log("   Clerk integration enabled for private endpoint");
  console.log("   Users must authenticate via Clerk to access /api/private/chat");
}

main().catch((error) => {
  console.error("Error starting server:", error);
  process.exit(1);
});
