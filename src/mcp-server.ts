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
import type { ChatterConfig } from "./types";

/**
 * MCP Server transport options
 */
export type MCPTransportMode = "stdio";

/**
 * Logging callback for observability
 */
export type MCPLogCallback = (event: {
  timestamp: string;
  toolName: string;
  conversationId?: string;
  userMessage: string;
  conversationHistory: Array<{ role: "user" | "assistant"; content: string }>;
  ragContext: string[];
  response: string;
  duration: number;
}) => void | Promise<void>;

/**
 * Configuration for individual MCP tools
 */
export interface MCPToolConfig {
  /** Enable this tool. Default: true */
  enabled?: boolean;
  /** Tool name override. Defaults to chat_public/chat_private */
  name?: string;
  /** Tool description override */
  description?: string;
}

export interface MCPServerOptions extends ChatterConfig {
  /** Transport mode. Default: stdio */
  transport?: MCPTransportMode;

  /** Configuration for MCP tools */
  tools?: {
    /** Public chat tool configuration */
    public?: MCPToolConfig;
    /** Private chat tool configuration */
    private?: MCPToolConfig;
  };

  /** Logging and observability */
  logging?: {
    /** Enable console logging. Default: true */
    console?: boolean;
    /** Custom logging callback for external monitoring */
    onChat?: MCPLogCallback;
  };
}

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
  const enableConsoleLogging = config.logging?.console !== false;
  const logCallback = config.logging?.onChat;

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

  // Logging helper
  const logChatInteraction = async (
    toolName: string,
    conversationMessages: Array<{ role: "user" | "assistant"; content: string }>,
    ragContext: string[],
    response: string,
    duration: number,
  ) => {
    const lastUserMsg = [...conversationMessages].reverse().find((m) => m.role === "user");

    const logEvent = {
      timestamp: new Date().toISOString(),
      toolName,
      userMessage: lastUserMsg?.content || "",
      conversationHistory: conversationMessages,
      ragContext,
      response,
      duration,
    };

    // Console logging
    if (enableConsoleLogging) {
      console.log(
        JSON.stringify({
          event: "mcp_chat",
          ...logEvent,
        }),
      );
    }

    // Custom callback
    if (logCallback) {
      await logCallback(logEvent);
    }
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
        const { message, messages } = args;
        const startTime = Date.now();

        // Parse input
        let conversationMessages: Array<{ role: "user" | "assistant"; content: string }>;

        if (messages && Array.isArray(messages)) {
          conversationMessages = messages;
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

        // Log interaction
        const duration = Date.now() - startTime;
        await logChatInteraction(
          publicToolConfig.name,
          conversationMessages,
          ctx,
          result.content,
          duration,
        ).catch((err) => console.error("Logging error:", err));

        return {
          content: [
            {
              type: "text",
              text: result.content,
            },
          ],
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
        const { message, messages } = args;
        const startTime = Date.now();

        // Parse input
        let conversationMessages: Array<{ role: "user" | "assistant"; content: string }>;

        if (messages && Array.isArray(messages)) {
          conversationMessages = messages;
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

        // Log interaction
        const duration = Date.now() - startTime;
        await logChatInteraction(
          privateToolConfig.name,
          conversationMessages,
          ctx,
          result.content,
          duration,
        ).catch((err) => console.error("Logging error:", err));

        return {
          content: [
            {
              type: "text",
              text: result.content,
            },
          ],
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
