#!/usr/bin/env node
/**
 * Example MCP Server for Chatter
 *
 * This example shows how to set up a Chatter MCP server that can be used
 * with Claude Desktop, VS Code extensions, or other MCP-compatible clients.
 *
 * Usage:
 *   1. Set environment variables: OPENAI_API_KEY, TURSO_URL, TURSO_AUTH_TOKEN
 *   2. Run: node examples/mcp-server-example.js
 *   3. Or add to your Claude Desktop config (see README.md)
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMCPServer } from "../src/mcp-server";

async function main() {
  // Create the MCP server with your configuration
  const server = await createMCPServer({
    bot: {
      name: "ChatterBot",
      personName: "Your Name",
      publicUrl: "https://bot.example.com",
      description: "An AI chatbot with RAG capabilities",
    },
    openai: {
      apiKey: process.env.OPENAI_API_KEY || "",
    },
    database: {
      url: process.env.TURSO_URL || "",
      authToken: process.env.TURSO_AUTH_TOKEN || "",
    },
    knowledgeDir: "./knowledge",
    promptsDir: "./prompts",
  });

  // Connect with STDIO transport (required for Claude Desktop)
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("MCP Server running and connected via STDIO");
}

main().catch((error) => {
  console.error("Error starting MCP server:", error);
  process.exit(1);
});
