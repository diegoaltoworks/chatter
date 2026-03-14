#!/usr/bin/env node
/**
 * Programmatic RAG Usage Example
 *
 * This example shows how to use Chatter's core modules directly
 * without running a full HTTP server. Useful for:
 * - Custom integrations
 * - Batch processing
 * - CLI tools
 * - Testing
 *
 * Usage:
 *   Set environment variables: OPENAI_API_KEY, TURSO_URL, TURSO_AUTH_TOKEN
 *   Run: bun run examples/programmatic-rag.ts
 */

import OpenAI from "openai";
import { PromptLoader, VectorStore, completeOnce } from "../src/index";

async function main() {
  console.log("🔧 Programmatic RAG Example\n");

  // Initialize OpenAI client
  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY || "",
  });

  // Create vector store (this will build/update the knowledge base)
  console.log("📚 Building knowledge base...");
  const store = new VectorStore(client, {
    databaseUrl: process.env.TURSO_URL || "",
    databaseAuthToken: process.env.TURSO_AUTH_TOKEN || "",
    knowledgeDir: "./knowledge",
  });
  await store.build();
  console.log("✅ Knowledge base ready\n");

  // Load prompts
  const prompts = new PromptLoader("./prompts", {
    name: "MyBot",
    personName: "My Company",
    publicUrl: "https://example.com",
    description: "AI Assistant",
  });

  // Example 1: Query knowledge base
  console.log("Example 1: RAG Query");
  const question = "What is your return policy?";
  console.log(`Question: ${question}`);

  const context = await store.query(question, 5, ["base", "public"]);
  console.log(`\nRetrieved ${context.length} context chunks:`);
  context.forEach((chunk, i) => {
    console.log(`  ${i + 1}. ${chunk.substring(0, 100)}...`);
  });

  // Example 2: Generate AI response with context
  console.log("\nExample 2: Generate Response with RAG");
  const system = [
    prompts.baseSystemRules,
    prompts.publicPersona,
    `Context:\n${context.join("\n\n")}`,
  ].join("\n\n");

  const result = await completeOnce({
    client,
    system,
    messages: [{ role: "user", content: question }],
  });

  console.log(`\nAI Response: ${result.content}\n`);

  // Example 3: Multi-turn conversation
  console.log("Example 3: Multi-turn Conversation");
  const conversation = [
    { role: "user" as const, content: "What are your business hours?" },
    { role: "assistant" as const, content: "We are open Monday-Friday 9am-5pm EST." },
    { role: "user" as const, content: "Do you have weekend support?" },
  ];

  const conversationContext = await store.query(conversation[conversation.length - 1].content, 5, [
    "base",
    "public",
  ]);

  const conversationSystem = [
    prompts.baseSystemRules,
    prompts.publicPersona,
    `Context:\n${conversationContext.join("\n\n")}`,
  ].join("\n\n");

  const conversationResult = await completeOnce({
    client,
    system: conversationSystem,
    messages: conversation,
  });

  console.log("Conversation:");
  for (const msg of conversation) {
    console.log(`  ${msg.role}: ${msg.content}`);
  }
  console.log(`  assistant: ${conversationResult.content}\n`);

  console.log("✅ Programmatic examples completed");
}

main().catch((error) => {
  console.error("❌ Error:", error);
  process.exit(1);
});
