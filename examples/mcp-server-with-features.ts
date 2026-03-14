#!/usr/bin/env node
/**
 * Advanced MCP Server Example
 *
 * This example demonstrates the new MCP features:
 * - Conversation ID tracking for session continuity
 * - Cost tracking and token usage monitoring
 * - Per-tool rate limiting
 * - Comprehensive logging with cost data
 *
 * Usage:
 *   1. Set environment variables: OPENAI_API_KEY, TURSO_URL, TURSO_AUTH_TOKEN
 *   2. Run: node examples/mcp-server-with-features.js
 *   3. Or add to your Claude Desktop config (see README.md)
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMCPServer } from "../src/mcp-server";

async function main() {
  // Track total costs across all conversations
  let totalCost = 0;
  let totalTokens = 0;
  const conversationCosts = new Map<string, number>();

  // Create the MCP server with all enhanced features
  const server = await createMCPServer({
    bot: {
      name: "ChatterBot",
      personName: "Your Name",
      publicUrl: "https://bot.example.com",
      description: "An AI chatbot with RAG capabilities and cost tracking",
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

    // NEW: Rate limiting per tool (30 requests per minute)
    toolRateLimit: 30,

    // NEW: Enhanced logging with cost tracking
    logging: {
      console: true, // Built-in JSON logging

      // Custom callback for monitoring and cost tracking
      onChat: async (event) => {
        // Track per-conversation costs
        const currentCost = conversationCosts.get(event.conversationId) || 0;
        conversationCosts.set(event.conversationId, currentCost + event.cost.estimatedCost);

        // Accumulate total costs
        totalCost += event.cost.estimatedCost;
        totalTokens += event.cost.totalTokens;

        // Log to stderr (stdout is used for MCP protocol)
        console.error("=".repeat(60));
        console.error(`Conversation: ${event.conversationId}`);
        console.error(`Tool: ${event.toolName}`);
        console.error(`User: ${event.userMessage.substring(0, 50)}...`);
        console.error(`Response Length: ${event.response.length} chars`);
        console.error(`Duration: ${event.duration}ms`);
        console.error("-".repeat(60));
        console.error(
          `Tokens (prompt/completion/total): ${event.cost.promptTokens}/${event.cost.completionTokens}/${event.cost.totalTokens}`,
        );
        console.error(`This request cost: $${event.cost.estimatedCost.toFixed(6)}`);
        console.error(
          `This conversation total: $${conversationCosts.get(event.conversationId)?.toFixed(6)}`,
        );
        console.error(`Session total: $${totalCost.toFixed(6)} (${totalTokens} tokens)`);
        console.error("=".repeat(60));

        // Optional: Send to external monitoring service
        // await fetch('https://your-logging-service.com/events', {
        //   method: 'POST',
        //   body: JSON.stringify({
        //     ...event,
        //     cumulative_cost: totalCost,
        //     cumulative_tokens: totalTokens
        //   })
        // });

        // Optional: Alert if costs exceed threshold
        if (totalCost > 1.0) {
          console.error("⚠️  WARNING: Total session cost exceeded $1.00");
        }
      },
    },

    // Optional: Customize tool names
    tools: {
      public: {
        enabled: true,
        name: "search_knowledge",
        description: "Search our knowledge base for answers",
      },
      private: {
        enabled: true, // Keep default settings
      },
    },
  });

  // Connect with STDIO transport (required for Claude Desktop)
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("✅ Advanced MCP Server running with cost tracking enabled");
  console.error("   Features: conversation IDs, cost tracking, rate limiting");
}

main().catch((error) => {
  console.error("Error starting MCP server:", error);
  process.exit(1);
});
