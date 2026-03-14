/**
 * Chatter MCP Server
 *
 * Model Context Protocol server implementation that exposes Chatter's
 * AI chat capabilities as MCP tools for use with Claude Desktop,
 * VS Code extensions, and other MCP-compatible clients.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import OpenAI from "openai";
import { z } from "zod";
import { completeOnce } from "./core/llm";
import { PromptLoader } from "./core/prompts";
import { VectorStore } from "./core/retrieval";
import { getOrGenerateConversationId } from "./mcp-server/conversation-id";
import { calculateCost } from "./mcp-server/cost-tracker";
import { createLogger } from "./mcp-server/logger";
import { createRateLimiter } from "./mcp-server/rate-limiter";

// Re-export types for backward compatibility
export type {
  ChatMessage,
  CostInfo,
  MCPLogCallback,
  MCPServerOptions,
  MCPToolConfig,
  MCPTransportMode,
} from "./mcp-server/types";
import type { MCPServerOptions } from "./mcp-server/types";

/**
 * Create and configure an MCP server instance
 *
 * @param config - Chatter configuration with optional MCP transport settings
 * @returns Configured MCP server ready to connect
 *
 * @example
 * ```typescript
 * import { createMCPServer } from '@diegoaltoworks/chatter/mcp';
 *
 * const server = await createMCPServer({
 *   bot: { name: 'MyBot', personName: 'Your Name' },
 *   openai: { apiKey: process.env.OPENAI_API_KEY },
 *   database: { url: process.env.TURSO_URL, authToken: process.env.TURSO_AUTH_TOKEN },
 *   knowledgeDir: './knowledge',
 *   promptsDir: './prompts',
 *   transport: 'stdio' // Default
 * });
 *
 * // Connect with STDIO transport
 * const transport = new StdioServerTransport();
 * await server.connect(transport);
 * ```
 */
export async function createMCPServer(config: MCPServerOptions) {
  console.log(`🚀 Starting ${config.bot.name} MCP Server...`);

  // Set defaults
  const knowledgeDir = config.knowledgeDir || "./config/knowledge";
  const promptsDir = config.promptsDir || "./config/prompts";
  const transportMode = config.transport || "stdio";

  // Initialize modular components
  const rateLimiter = createRateLimiter(config.toolRateLimit);
  const logger = createLogger(config.logging?.console !== false, config.logging?.onChat);

  // Tool configurations with defaults
  const publicToolConfig = {
    enabled: config.tools?.public?.enabled !== false,
    name: config.tools?.public?.name || "chat_public",
    description:
      config.tools?.public?.description ||
      `Chat with ${config.bot.name} using public knowledge base. Supports both single messages and conversation history.`,
  };

  const privateToolConfig = {
    enabled: config.tools?.private?.enabled !== false,
    name: config.tools?.private?.name || "chat_private",
    description:
      config.tools?.private?.description ||
      `Chat with ${config.bot.name} using private/internal knowledge base. Supports both single messages and conversation history.`,
  };

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

  // Create MCP server
  const server = new McpServer({
    name: config.bot.name,
    version: "1.0.0",
  });

  console.log("✅ MCP server initialized");

  // Register chat_public tool (if enabled)
  if (publicToolConfig.enabled) {
    const publicSchema = z
      .object({
        message: z.string().optional().describe("A single message to send (for simple queries)"),
        messages: z
          .array(
            z.object({
              role: z.enum(["user", "assistant"]),
              content: z.string(),
            }),
          )
          .optional()
          .describe("Conversation history with alternating user/assistant messages"),
        conversationId: z
          .string()
          .optional()
          .describe(
            "Optional conversation ID to track sessions. If not provided, a new ID will be generated.",
          ),
      })
      .refine(
        (data) => data.message !== undefined || data.messages !== undefined,
        "Either 'message' or 'messages' must be provided",
      );

    server.registerTool(
      publicToolConfig.name,
      {
        description: publicToolConfig.description,
        inputSchema: publicSchema,
      },
      async (args: z.infer<typeof publicSchema>) => {
        const { message, messages, conversationId } = args;
        const startTime = Date.now();

        // Generate or use provided conversation ID
        const convId = getOrGenerateConversationId(conversationId);

        // Check rate limit
        if (rateLimiter && !rateLimiter.check(publicToolConfig.name)) {
          throw new Error(
            `Rate limit exceeded for ${publicToolConfig.name}. Maximum ${config.toolRateLimit} requests per minute.`,
          );
        }

        // Parse input
        let conversationMessages: Array<{ role: "user" | "assistant"; content: string }>;

        if (messages && Array.isArray(messages)) {
          conversationMessages = messages as Array<{ role: "user" | "assistant"; content: string }>;
        } else if (message) {
          conversationMessages = [{ role: "user", content: String(message) }];
        } else {
          throw new Error("Either 'message' or 'messages' is required");
        }

        // Get the latest user message for RAG context
        const lastUserMsg = [...conversationMessages].reverse().find((m) => m.role === "user");
        if (!lastUserMsg) {
          throw new Error("No user message found in conversation");
        }

        // Retrieve context from knowledge base
        const ctx = await store.query(lastUserMsg.content, 6, ["base", "public"]);
        const system = [
          prompts.baseSystemRules,
          prompts.publicPersona,
          `Context:\n${ctx.join("\n\n")}`,
        ].join("\n\n");

        // Generate response
        const result = await completeOnce({
          client,
          system,
          messages: conversationMessages,
        });

        // Calculate cost
        const cost = calculateCost(result.usage);

        // Log interaction
        const duration = Date.now() - startTime;
        await logger
          .logChatInteraction(
            publicToolConfig.name,
            convId,
            conversationMessages,
            ctx,
            result.content,
            duration,
            cost,
          )
          .catch((err) => console.error("Logging error:", err));

        return {
          content: [
            {
              type: "text",
              text: result.content,
            },
          ],
          _meta: {
            conversationId: convId,
            cost: {
              promptTokens: cost.promptTokens,
              completionTokens: cost.completionTokens,
              totalTokens: cost.totalTokens,
              estimatedCostUSD: cost.estimatedCost,
            },
          },
        };
      },
    );

    console.log(`✅ Registered tool: ${publicToolConfig.name}`);
  }

  // Register chat_private tool (if enabled)
  if (privateToolConfig.enabled) {
    const privateSchema = z
      .object({
        message: z.string().optional().describe("A single message to send (for simple queries)"),
        messages: z
          .array(
            z.object({
              role: z.enum(["user", "assistant"]),
              content: z.string(),
            }),
          )
          .optional()
          .describe("Conversation history with alternating user/assistant messages"),
        conversationId: z
          .string()
          .optional()
          .describe(
            "Optional conversation ID to track sessions. If not provided, a new ID will be generated.",
          ),
      })
      .refine(
        (data) => data.message !== undefined || data.messages !== undefined,
        "Either 'message' or 'messages' must be provided",
      );

    server.registerTool(
      privateToolConfig.name,
      {
        description: privateToolConfig.description,
        inputSchema: privateSchema,
      },
      async (args: z.infer<typeof privateSchema>) => {
        const { message, messages, conversationId } = args;
        const startTime = Date.now();

        // Generate or use provided conversation ID
        const convId = getOrGenerateConversationId(conversationId);

        // Check rate limit
        if (rateLimiter && !rateLimiter.check(privateToolConfig.name)) {
          throw new Error(
            `Rate limit exceeded for ${privateToolConfig.name}. Maximum ${config.toolRateLimit} requests per minute.`,
          );
        }

        // Parse input
        let conversationMessages: Array<{ role: "user" | "assistant"; content: string }>;

        if (messages && Array.isArray(messages)) {
          conversationMessages = messages as Array<{ role: "user" | "assistant"; content: string }>;
        } else if (message) {
          conversationMessages = [{ role: "user", content: String(message) }];
        } else {
          throw new Error("Either 'message' or 'messages' is required");
        }

        // Get the latest user message for RAG context
        const lastUserMsg = [...conversationMessages].reverse().find((m) => m.role === "user");
        if (!lastUserMsg) {
          throw new Error("No user message found in conversation");
        }

        // Retrieve context from knowledge base (using private knowledge)
        const ctx = await store.query(lastUserMsg.content, 8, ["base", "private"]);
        const system = [
          prompts.baseSystemRules,
          prompts.privatePersona,
          `Internal Context:\n${ctx.join("\n\n")}`,
        ].join("\n\n");

        // Generate response
        const result = await completeOnce({
          client,
          system,
          messages: conversationMessages,
        });

        // Calculate cost
        const cost = calculateCost(result.usage);

        // Log interaction
        const duration = Date.now() - startTime;
        await logger
          .logChatInteraction(
            privateToolConfig.name,
            convId,
            conversationMessages,
            ctx,
            result.content,
            duration,
            cost,
          )
          .catch((err) => console.error("Logging error:", err));

        return {
          content: [
            {
              type: "text",
              text: result.content,
            },
          ],
          _meta: {
            conversationId: convId,
            cost: {
              promptTokens: cost.promptTokens,
              completionTokens: cost.completionTokens,
              totalTokens: cost.totalTokens,
              estimatedCostUSD: cost.estimatedCost,
            },
          },
        };
      },
    );

    console.log(`✅ Registered tool: ${privateToolConfig.name}`);
  }

  // Log summary
  const enabledTools = [
    publicToolConfig.enabled ? publicToolConfig.name : null,
    privateToolConfig.enabled ? privateToolConfig.name : null,
  ].filter(Boolean);

  if (enabledTools.length === 0) {
    console.warn("⚠️  Warning: No MCP tools enabled");
  }

  console.log(
    `✅ ${config.bot.name} MCP Server ready (transport: ${transportMode}, tools: ${enabledTools.join(", ") || "none"})`,
  );

  return server;
}
