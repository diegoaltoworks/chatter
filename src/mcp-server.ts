/**
 * Chatter MCP Server
 *
 * Model Context Protocol server implementation that exposes Chatter's
 * AI chat capabilities as MCP tools for use with Claude Desktop,
 * VS Code extensions, and other MCP-compatible clients.
 */

import OpenAI from "openai";
import type { z as ZodNamespace } from "zod";
import { answerOnce, applyTransformReply } from "./core/answer";
import { resolveBuckets } from "./core/buckets";
import { DEFAULT_MODEL } from "./core/llm";
import { resolveLogger } from "./core/logger";
import { lastUserMessage } from "./core/messages";
import { prepareChat } from "./core/pipeline";
import { DEFAULT_PROMPTS_DIR, PromptLoader } from "./core/prompts";
import type { Retriever } from "./core/retrieval";
import { getOrGenerateConversationId } from "./mcp-server/conversation-id";
import { calculateCost } from "./mcp-server/cost-tracker";
import { createLogger } from "./mcp-server/logger";
import { createMcpRateLimiter } from "./mcp-server/rate-limiter";
import { loadMcpSdk, loadZod } from "./mcp-server/sdk";
import { resolveConversationMessages } from "./mcp-server/tool-input";

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
  // Every startup/registration message below goes through `log`, whose
  // default implementation never writes to stdout - the stdio transport
  // reserves stdout for the JSON-RPC stream, so a raw console.log here would
  // corrupt it.
  const log = resolveLogger(config.logger, config.logLevel);
  log.info(`🚀 Starting ${config.bot.name} MCP Server...`);

  // Optional peers, loaded lazily so core installs/imports never require them.
  const [McpServer, z] = await Promise.all([loadMcpSdk(), loadZod()]);

  const promptsDir = config.promptsDir || DEFAULT_PROMPTS_DIR;
  const transportMode = config.transport || "stdio";

  const rateLimiter = createMcpRateLimiter(config.toolRateLimit);
  const logger = createLogger(config.logging?.console !== false, config.logging?.onChat, log);

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

  const client = new OpenAI({
    apiKey: config.openai.apiKey,
  });
  const model = config.openai.model || DEFAULT_MODEL;

  // Build the retrieval backend: a caller-supplied Retriever (see
  // `config.retriever` in ./types), or the default VectorStore backed by
  // libsql + OpenAI embeddings. `@libsql/client` is only imported along the
  // default path, so a host supplying `config.retriever` with no
  // `config.database` never needs it installed.
  let store: Retriever;
  if (config.retriever) {
    store = config.retriever;
  } else {
    if (!config.database) {
      throw new Error(
        "config.database is required unless config.retriever is set - Chatter's default " +
          "knowledge store (VectorStore) needs a Turso/libsql connection. Set config.database, " +
          "or supply config.retriever to use your own retrieval backend instead.",
      );
    }
    const { DEFAULT_KNOWLEDGE_DIR, VectorStore, createOpenAIEmbedder, openLibsqlClient } =
      await import("./core/retrieval");
    const db = await openLibsqlClient(config.database);
    store = new VectorStore(createOpenAIEmbedder(client), {
      databaseClient: db,
      knowledgeDir: config.knowledgeDir || DEFAULT_KNOWLEDGE_DIR,
      logger: log,
    });
  }
  await store.build?.();
  log.info("✅ Knowledge base ready");

  const prompts = new PromptLoader(promptsDir, config.bot);

  const server = new McpServer({
    name: config.bot.name,
    version: "1.0.0",
  });

  log.info("✅ MCP server initialized");

  if (publicToolConfig.enabled) {
    const publicShape = {
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
    };

    server.registerTool(
      publicToolConfig.name,
      {
        description: publicToolConfig.description,
        inputSchema: publicShape,
      },
      async (args: ZodNamespace.infer<ZodNamespace.ZodObject<typeof publicShape>>) => {
        const { message, messages, conversationId } = args;
        const startTime = Date.now();

        const convId = getOrGenerateConversationId(conversationId);

        if (rateLimiter && !rateLimiter.check(publicToolConfig.name)) {
          throw new Error(
            `Rate limit exceeded for ${publicToolConfig.name}. Maximum ${config.toolRateLimit} requests per minute.`,
          );
        }

        const conversationMessages = resolveConversationMessages(message, messages);

        if (!lastUserMessage(conversationMessages)) {
          throw new Error("No user message found in conversation");
        }

        // Retrieve context from knowledge base. MCP tools carry no per-user
        // identity, so the hook may narrow the scope but not widen it.
        const buckets = await resolveBuckets({ mode: "public", bucketsFor: config.bucketsFor });
        const { system, context: ctx } = await prepareChat({
          store,
          prompts,
          mode: "public",
          messages: conversationMessages,
          buckets,
          rewriteQuery: config.rewriteQuery,
          rerankContext: config.rerankContext,
          logger: log,
        });

        const result = await answerOnce({
          answerFn: config.answerFn,
          client,
          system,
          messages: conversationMessages,
          mode: "public",
          conversationId: convId,
          model,
        });

        const replyText = await applyTransformReply(
          config.transformReply,
          { channel: "mcp-public", conversationId: convId, text: result.content },
          log,
        );

        const cost = calculateCost(result.usage, config.openai.pricing);

        const duration = Date.now() - startTime;
        await logger
          .logChatInteraction(
            publicToolConfig.name,
            convId,
            conversationMessages,
            ctx,
            replyText ?? "",
            duration,
            cost,
          )
          .catch((err) => log.error("Logging error:", err));

        return {
          content: [
            {
              type: "text",
              text: replyText ?? "",
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

    log.info(`✅ Registered tool: ${publicToolConfig.name}`);
  }

  if (privateToolConfig.enabled) {
    const privateShape = {
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
    };

    server.registerTool(
      privateToolConfig.name,
      {
        description: privateToolConfig.description,
        inputSchema: privateShape,
      },
      async (args: ZodNamespace.infer<ZodNamespace.ZodObject<typeof privateShape>>) => {
        const { message, messages, conversationId } = args;
        const startTime = Date.now();

        const convId = getOrGenerateConversationId(conversationId);

        if (rateLimiter && !rateLimiter.check(privateToolConfig.name)) {
          throw new Error(
            `Rate limit exceeded for ${privateToolConfig.name}. Maximum ${config.toolRateLimit} requests per minute.`,
          );
        }

        const conversationMessages = resolveConversationMessages(message, messages);

        if (!lastUserMessage(conversationMessages)) {
          throw new Error("No user message found in conversation");
        }

        const buckets = await resolveBuckets({ mode: "private", bucketsFor: config.bucketsFor });
        const { system, context: ctx } = await prepareChat({
          store,
          prompts,
          mode: "private",
          messages: conversationMessages,
          buckets,
          rewriteQuery: config.rewriteQuery,
          rerankContext: config.rerankContext,
          logger: log,
        });

        const result = await answerOnce({
          answerFn: config.answerFn,
          client,
          system,
          messages: conversationMessages,
          mode: "private",
          conversationId: convId,
          model,
        });

        const replyText = await applyTransformReply(
          config.transformReply,
          { channel: "mcp-private", conversationId: convId, text: result.content },
          log,
        );

        const cost = calculateCost(result.usage, config.openai.pricing);

        const duration = Date.now() - startTime;
        await logger
          .logChatInteraction(
            privateToolConfig.name,
            convId,
            conversationMessages,
            ctx,
            replyText ?? "",
            duration,
            cost,
          )
          .catch((err) => log.error("Logging error:", err));

        return {
          content: [
            {
              type: "text",
              text: replyText ?? "",
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

    log.info(`✅ Registered tool: ${privateToolConfig.name}`);
  }

  const enabledTools = [
    publicToolConfig.enabled ? publicToolConfig.name : null,
    privateToolConfig.enabled ? privateToolConfig.name : null,
  ].filter(Boolean);

  if (enabledTools.length === 0) {
    log.warn("⚠️  Warning: No MCP tools enabled");
  }

  log.info(
    `✅ ${config.bot.name} MCP Server ready (transport: ${transportMode}, tools: ${enabledTools.join(", ") || "none"})`,
  );

  return server;
}
