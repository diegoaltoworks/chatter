/**
 * CLI tool for creating Chatter API keys
 *
 * Usage:
 *   npx chatter --name "my-key" --expires-in 365d
 *   bun run bin/create-apikey.ts --name "test" --expires-in 1y
 *
 * `chatter` is this single-purpose binary (see package.json's `bin` map),
 * not a multi-command CLI - there is no `create-apikey` subcommand to type.
 *
 * Argument parsing is pure and unit-tested separately - see
 * create-apikey-args.ts and its test file.
 */

import { ApiKeyManager } from "../src/auth/apikeys";
import { assertStrongSecret } from "../src/auth/secretStrength";
import { parseArgs } from "./create-apikey-args";

const HELP_TEXT = `
Chatter API Key Generator

Usage:
  npx chatter [options]

Options:
  --name <name>          Name/label for the API key (default: "api-key")
  --expires-in <time>    Expiration time (default: "365d")
                         Formats: s=seconds, m=minutes, h=hours, d=days, M=months, y=years
                         Examples: 30d, 12h, 1y, 6M
  --help, -h             Show this help.

Environment:
  CHATTER_SECRET         Required. Secret key for signing JWT tokens

Examples:
  npx chatter --name "mobile-app" --expires-in 365d
  npx chatter --name "test-key" --expires-in 1h
`;

async function main() {
  const parsed = parseArgs(process.argv.slice(2));

  if (!parsed.ok) {
    console.error(`❌ ${parsed.error}`);
    console.log(HELP_TEXT);
    process.exit(1);
  }
  if (parsed.help) {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  const secret = process.env.CHATTER_SECRET;
  try {
    assertStrongSecret(secret, "CHATTER_SECRET");
  } catch (error) {
    console.error(`❌ ${(error as Error).message}`);
    console.error("\n   Set it before running this command:");
    console.error("   export CHATTER_SECRET=your-secret-key-here");
    console.error("\n   Or prefix the command:");
    console.error("   CHATTER_SECRET=your-secret npx chatter\n");
    process.exit(1);
  }

  // Create API key manager
  const manager = new ApiKeyManager(secret);

  // Default values
  const keyName = parsed.name || "api-key";
  const expiresIn = parsed.expiresIn || "365d";

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
    console.log(`     -H "x-api-key: ${apiKey}" \\`);
    console.log('     -H "Content-Type: application/json" \\');
    console.log('     -d \'{"message": "Hello"}\'');
    console.log("");
  } catch (error) {
    console.error(`❌ Error creating API key: ${(error as Error).message}`);
    process.exit(1);
  }
}

main();
