#!/usr/bin/env node
/**
 * CLI tool for creating Chatter API keys
 *
 * Usage:
 *   npx chatter create-apikey --name "my-key" --expires-in 365d
 *   bun run bin/create-apikey.ts --name "test" --expires-in 1y
 */

import { ApiKeyManager } from "../src/auth/apikeys";

async function main() {
  // Parse command line arguments
  const args = process.argv.slice(2);
  const options: { name?: string; expiresIn?: string } = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--name" && args[i + 1]) {
      options.name = args[i + 1];
      i++;
    } else if (args[i] === "--expires-in" && args[i + 1]) {
      options.expiresIn = args[i + 1];
      i++;
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log(`
Chatter API Key Generator

Usage:
  npx chatter create-apikey [options]

Options:
  --name <name>          Name/label for the API key (default: "api-key")
  --expires-in <time>    Expiration time (default: "365d")
                         Formats: s=seconds, m=minutes, h=hours, d=days, M=months, y=years
                         Examples: 30d, 12h, 1y, 6M

Environment:
  CHATBOT_SECRET         Required. Secret key for signing JWT tokens

Examples:
  npx chatter create-apikey --name "mobile-app" --expires-in 365d
  npx chatter create-apikey --name "test-key" --expires-in 1h
      `);
      process.exit(0);
    }
  }

  // Check for CHATBOT_SECRET
  const secret = process.env.CHATBOT_SECRET;
  if (!secret) {
    console.error("❌ Error: CHATBOT_SECRET environment variable is not set");
    console.error("\n   Please set it before running this command:");
    console.error("   export CHATBOT_SECRET=your-secret-key-here");
    console.error("\n   Or prefix the command:");
    console.error("   CHATBOT_SECRET=your-secret npx chatter create-apikey\n");
    process.exit(1);
  }

  // Create API key manager
  const manager = new ApiKeyManager(secret);

  // Default values
  const keyName = options.name || "api-key";
  const expiresIn = options.expiresIn || "365d";

  try {
    // Create the API key
    const apiKey = await manager.create({
      name: keyName,
      expiresIn,
    });

    // Decode to show details (without verification for display)
    const payload = manager.decode(apiKey);
    if (!payload) {
      throw new Error("Failed to decode generated API key");
    }

    const expiresAt = new Date((payload.exp || 0) * 1000);
    const issuedAt = new Date((payload.iat || 0) * 1000);

    // Output the result
    console.log("\n✅ API Key generated successfully!\n");
    console.log(`   Name:       ${keyName}`);
    console.log(`   ID:         ${payload.sub}`);
    console.log(`   Issued:     ${issuedAt.toISOString()}`);
    console.log(`   Expires:    ${expiresAt.toISOString()} (${expiresIn})`);
    console.log(`\n   API Key:\n   ${apiKey}\n`);
    console.log("   Usage:");
    console.log("   curl -X POST https://your-bot.example.com/api/public/chat \\");
    console.log(`     -H "x-api-key: ${apiKey.slice(0, 50)}..." \\`);
    console.log('     -H "Content-Type: application/json" \\');
    console.log('     -d \'{"message": "Hello"}\'');
    console.log("");
  } catch (error) {
    console.error("❌ Error creating API key:", error);
    process.exit(1);
  }
}

main();
