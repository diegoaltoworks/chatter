# Chatter

<div align="center">

**Embeddable AI chatbot framework with RAG, authentication, and customizable widgets**

[![NPM Version](https://img.shields.io/npm/v/@diegoaltoworks/chatter)](https://www.npmjs.com/package/@diegoaltoworks/chatter)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![CI](https://github.com/diegoaltoworks/chatter/actions/workflows/ci.yml/badge.svg)](https://github.com/diegoaltoworks/chatter/actions/workflows/ci.yml)
[![Demo](https://img.shields.io/badge/demo-chatter--demo-blue)](https://github.com/diegoaltoworks/chatter-demo)

[Features](#features) - [Quick Start](#quick-start) - [Documentation](#documentation) - [Demo](#demo)

</div>

## Features

- 🤖 **RAG-Powered**: Retrieval-Augmented Generation using OpenAI embeddings and Turso vector database
- 🎨 **Customizable Widgets**: Pre-built chat components (ChatBot, Chat, ChatButton) with full styling control
- 📝 **Markdown Rendering**: Assistant replies render Markdown (headings, lists, code blocks, links) safely with HTML escaping
- 🔌 **OpenAI-Compatible API**: `POST /v1/chat/completions` (streaming + non-streaming) so any chat UI or SDK - [Deep Chat](https://deepchat.dev), [assistant-ui](https://www.assistant-ui.com), the OpenAI SDKs - can be the front end ([guide](./docs/integrations.md))
- 🎛️ **Headless Mode**: Run the server as a pure API with `features: { headless: true }` - no built-in widget or demo pages
- 🔐 **Built-in API Key Management**: JWT-based API keys with CLI tool for easy creation
- 🔑 **Authentication Ready**: Built-in support for JWT, Clerk, and custom auth providers
- 📱 **Mobile Optimized**: Responsive design with iOS/Android-specific fixes
- ⚡ **High Performance**: Built on Hono with streaming support
- 🛡️ **Security First**: Rate limiting, CORS, referrer checking, and input guardrails
- 💸 **Usage Metering**: Per-caller and global daily caps for paid features, multi-instance safe, via `@diegoaltoworks/chatter/usage` ([guide](./docs/usage.md))
- 💬 **Channels**: Built-in WhatsApp, Telegram and Matrix transports plus a Channel SPI for plugging in any other one - allowlist/mute gates, reply rate-limiting, and a shared inbound pipeline every channel reuses ([WhatsApp](./docs/channels.md), [Telegram](./docs/telegram.md), [Matrix](./docs/matrix.md), [build your own](./docs/build-a-channel.md))
- 🧩 **Flows**: Multi-turn, schema-driven slot-filling for structured conversations, with hybrid keyword + LLM intent matching ([guide](./docs/flows.md))
- 🖼️ **Images**: On-demand generation and editing with cache-before-spend ordering and optional Cloudinary upload ([guide](./docs/images.md))
- 🎭 **Personas**: Windowed, per-contact prompt layers and named greetings from a JSON registry ([guide](./docs/personas.md))
- 🗂️ **Conversation History**: Structural, multi-turn context store, multi-instance safe and host-replaceable ([guide](./docs/history.md))
- ⏰ **Scheduler**: Exactly-once outbound scheduling with a fire-time grace window, multi-instance safe ([guide](./docs/scheduler.md))
- 📦 **Framework Agnostic**: Works with any JavaScript framework or vanilla JS
- 🎯 **TypeScript**: Fully typed for excellent developer experience

## Quick Start

```bash
# Install
npm install @diegoaltoworks/chatter

# Create server
import { createServer } from '@diegoaltoworks/chatter';

const app = await createServer({
  bot: { name: 'MyBot', personName: 'Your Name' },
  openai: { apiKey: process.env.OPENAI_API_KEY },
  database: { url: process.env.TURSO_URL, authToken: process.env.TURSO_AUTH_TOKEN },
  auth: { secret: process.env.CHATTER_SECRET },
  knowledgeDir: './knowledge',
  promptsDir: './prompts'
});

Bun.serve({ port: 8181, fetch: app.fetch });

# Create API key for clients
npx chatter --name "my-app" --expires-in 365d
```

**Requirements:** OpenAI API key, Turso database, and Bun >= 1.2 or Node >= 24. See [Requirements Guide](./docs/requirements.md) for setup instructions.

### Runtime

The package runs on **Bun or Node** (>= 24 - it is built and published for both,
and CI loads the built bundles under each). Two things differ:

- **Serving the app** - `Bun.serve({ port: 8181, fetch: app.fetch })` on Bun;
  `serve({ port: 8181, fetch: app.fetch })` from [`@hono/node-server`](https://github.com/honojs/node-server) on Node.
- **Static assets** - serving the widget files (`/chatter.js`, `/chatter.css`)
  and a `publicDir` needs a runtime adapter, picked automatically. On Node that
  adapter is `@hono/node-server`, an optional peer dependency: without it,
  `/chatter.js` and `/chatter.css` 404 and the server logs an actionable
  error naming the missing package. Install it, or run with
  `features: { headless: true }` if the server should serve no files.

Everything else - the chat pipeline, RAG, channels, the OpenAI-compatible API -
is runtime-neutral. Development and the quality gates run on Bun.

## Examples

**[📁 Complete Examples](./examples/)** - Ready-to-run examples for all use cases:

- **[HTTP Server (Basic)](./examples/http-server-basic.ts)** - Production-ready HTTP API
- **[HTTP Server + Clerk](./examples/http-server-with-clerk.ts)** - With authentication
- **[MCP Server](./examples/mcp-server-example.ts)** - For Claude Desktop integration
- **[API Client](./examples/api-client-usage.ts)** - Call Chatter from code
- **[Programmatic RAG](./examples/programmatic-rag.ts)** - Use core modules directly

## Documentation

Complete guides for setup, deployment, and integration - see
[docs/index.md](./docs/index.md) for the full, ordered walkthrough:

- **[Architecture](./docs/ARCHITECTURE.md)** - Load-bearing invariants, each linked to the test that enforces it
- **[Requirements](./docs/requirements.md)** - OpenAI, Turso, Clerk setup and pricing
- **[Server Setup](./docs/server.md)** - Configuration, knowledge base, prompts, API keys
- **[Client Integration](./docs/client.md)** - Widgets, React components, theming
- **[UI Integrations](./docs/integrations.md)** - OpenAI-compatible API, headless mode, bring-your-own-brain
- **[Usage Metering](./docs/usage.md)** - Daily spend caps for paid features
- **[Personas](./docs/personas.md)** - Dynamic prompt layers and named greetings
- **[WhatsApp Channel](./docs/channels.md)** - Link a WhatsApp number as a transport
- **[Building a Channel](./docs/build-a-channel.md)** - Plug in a new transport
- **[Telegram Channel](./docs/telegram.md)** - Run a bot on the official Bot API, no extra dependency
- **[Matrix Channel](./docs/matrix.md)** - Run a bot on the client-server API, no extra dependency (unencrypted rooms only)
- **[Flows](./docs/flows.md)** - Multi-turn, schema-driven slot-filling flows
- **[Images](./docs/images.md)** - Generate and cache images on demand
- **[Conversation History](./docs/history.md)** - Structural, host-replaceable multi-turn context
- **[Scheduler](./docs/scheduler.md)** - Exactly-once outbound scheduling
- **[Deployment](./docs/deployment.md)** - Google Cloud Run, Fly.io, Railway, VPS
- **[Packaging](./docs/packaging.md)** - The subpath contract and the release chain
- **[Testing](./docs/testing.md)** - Comprehensive testing guide
- **[FAQs](./docs/faqs.md)** - Troubleshooting and common questions
- **Architecture Decisions** - The ADRs behind the shape of the codebase:
  [0001, brain and sockets split](./docs/decisions/0001-brain-and-sockets-split.md),
  [0002, no LangChain in core](./docs/decisions/0002-no-langchain-in-core.md),
  [0003, slot-filling is brain territory](./docs/decisions/0003-slot-filling-is-brain-territory.md),
  [0004, main-protection keeps only non-fast-forward and deletion protections](./docs/decisions/0004-main-protection-stays-non-fast-forward-only.md)
- **Patterns** - Worked "how do I add X" guides:
  [adding a capability](./docs/patterns/adding-a-capability.md),
  [adding a store](./docs/patterns/adding-a-store.md),
  [adding a retriever](./docs/patterns/adding-a-retriever.md),
  [exemplars](./docs/patterns/exemplars.md)

### Archive

- **[Cross-Module Review](./docs/sprint-review.md)** - A dated, point-in-time
  audit (v0.40) of cross-module paths and security invariants, not a
  standing guarantee about the current codebase.

## Demo

**🎯 [View Live Demo & Complete Implementation Example](https://github.com/diegoaltoworks/chatter-demo)**

The [chatter-demo](https://github.com/diegoaltoworks/chatter-demo) repository contains a complete, production-ready implementation showing:

- Full server setup with custom configuration
- 8 live demo implementations (Widget/React x Button/Inline x Public/Private)
- Clerk authentication integration
- Deployment configuration for Google Cloud Run
- Knowledge base and prompt customization
- Complete source code you can fork and customize

Perfect for understanding how to customize and deploy your own Chatter service.

## Client Integration

Add chat to your website with pre-built widgets or React components:

**Vanilla JavaScript** (load from your server):
```html
<script src="https://your-bot.example.com/chatter.js"></script>
<script>
  new Chatter.ChatButton({
    host: 'your-bot.example.com',
    mode: 'public',
    apiKey: 'your-api-key'
  });
</script>
```

**React/NPM**:
```typescript
import { ChatButton } from '@diegoaltoworks/chatter/client';
import '@diegoaltoworks/chatter/client/style.css';

new ChatButton({ host: 'your-bot.example.com', mode: 'public', apiKey: '...' });
```

See [Client Setup Guide](./docs/client.md) for detailed integration examples, theming, and authentication options.

## MCP Server Integration

Use Chatter as a Model Context Protocol (MCP) server to expose your chatbot to Claude Desktop, VS Code extensions, and other MCP-compatible tools. `@modelcontextprotocol/sdk` and `zod` are optional peer dependencies scoped to this subpath - install them to use it: `bun add @modelcontextprotocol/sdk zod`.

**Basic Setup:**
```typescript
import { createMCPServer } from '@diegoaltoworks/chatter/mcp';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = await createMCPServer({
  bot: { name: 'MyBot', personName: 'Your Name' },
  openai: { apiKey: process.env.OPENAI_API_KEY },
  database: { url: process.env.TURSO_URL, authToken: process.env.TURSO_AUTH_TOKEN },
  knowledgeDir: './knowledge',
  promptsDir: './prompts'
});

// Connect with STDIO transport (for Claude Desktop)
const transport = new StdioServerTransport();
await server.connect(transport);
```

**Customize Tools:**
```typescript
const server = await createMCPServer({
  // ... other config ...
  tools: {
    public: {
      enabled: true,
      name: 'company_docs',
      description: 'Search company documentation and FAQs'
    },
    private: {
      enabled: false  // Disable private tool
    }
  }
});
```

**Conversation Tracking & Cost Management:**
```typescript
const server = await createMCPServer({
  // ... other config ...
  toolRateLimit: 30,  // Max 30 requests per minute per tool (optional)
  logging: {
    console: true,   // JSON `mcp_chat` events via the logger, stderr (default: true)
    content: false,  // also log the conversation itself (default: false)
    onChat: async (event) => {
      // Custom logging - includes conversation tracking and cost data
      console.log('Chat event:', {
        timestamp: event.timestamp,
        conversationId: event.conversationId,  // Track sessions across calls
        tool: event.toolName,
        user_message: event.userMessage,
        conversation_length: event.conversationHistory.length,
        rag_chunks: event.ragContext.length,
        response_length: event.response.length,
        duration_ms: event.duration,
        // OpenAI API usage and cost tracking
        cost: {
          promptTokens: event.cost.promptTokens,
          completionTokens: event.cost.completionTokens,
          totalTokens: event.cost.totalTokens,
          estimatedCostUSD: event.cost.estimatedCost
        }
      });
      
      // Example: Send to external monitoring
      // await fetch('https://your-logging-service.com/events', {
      //   method: 'POST',
      //   body: JSON.stringify(event)
      // });
    }
  }
});
```

The default `mcp_chat` console event carries metadata only: tool name,
conversation id, message and context counts, duration and token cost. Set
`logging.content: true` plus `logLevel: "debug"` to also get an
`mcp_chat_content` event with the user message, history, retrieved context and
answer. `onChat` always receives the full event, since the host decides where
it lands. Content is scrubbed of credentials wherever it is emitted. See
[docs/server.md](docs/server.md#logging).

**Claude Desktop Configuration:**

Add to your `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "chatter": {
      "command": "node",
      "args": ["/path/to/your/mcp-server.js"],
      "env": {
        "OPENAI_API_KEY": "your-key",
        "TURSO_URL": "your-url",
        "TURSO_AUTH_TOKEN": "your-token"
      }
    }
  }
}
```

**Available Tools (configurable):**
- `chat_public` (default name) - Chat using public knowledge base
- `chat_private` (default name) - Chat using private/internal knowledge base

Both tools:
- Support single messages or full conversation history
- Track conversation IDs across sessions for continuity
- Return token usage in response metadata, plus an estimated USD cost when `openai.pricing` is configured
- Use RAG-powered context retrieval from your knowledge base
- Can be customized with different names and descriptions
- Can be individually enabled/disabled
- Optional per-tool rate limiting

**Features:**
- **Conversation ID Tracking**: Pass `conversationId` parameter to maintain session continuity across tool calls
- **Cost Tracking**: Every response includes token usage (prompt/completion/total). Add `openai: { pricing: { promptPer1M, completionPer1M } }` to also get an estimated USD cost - without it, `estimatedCost` is `null` rather than guessing at a price for the wrong model
- **Rate Limiting**: Optional per-tool rate limiting (requests per minute) to control API usage
- **Observability**: Comprehensive logging with conversation tracking and cost data

## Plugins

### Talker - Voice Calls, SMS & WhatsApp

Add phone call and SMS support to your Chatter bot with [Talker](https://github.com/diegoaltoworks/talker):

```bash
bun add @diegoaltoworks/talker
```

```typescript
import { createServer } from '@diegoaltoworks/chatter';
import { createTelephonyRoutes } from '@diegoaltoworks/talker';

const app = await createServer({
  ...config,
  customRoutes: async (app, deps) => {
    await createTelephonyRoutes(app, deps, {
      twilio: { accountSid, authToken, phoneNumber },
      transferNumber: '+441234567890',
    });
  },
});
```

One server, one port - web chat, phone calls, and SMS. See the [Talker README](https://github.com/diegoaltoworks/talker) for full documentation.

### Two ways to do WhatsApp

Chatter's own [WhatsApp channel](./docs/channels.md) and Talker's Twilio
integration both reach WhatsApp, through very different paths - pick based on
what you're building:

| | This repo's [WhatsApp channel](./docs/channels.md) | Talker's Twilio WhatsApp |
| --- | --- | --- |
| WhatsApp access | Unofficial, via [Baileys](https://github.com/WhiskeySockets/Baileys) - a linked-device client, not the WhatsApp Business API | Sanctioned path, via Twilio's WhatsApp Business API integration |
| Cost | Free besides hosting | Twilio usage-based pricing |
| Risk | Real risk of the linked number being banned - use a number you can afford to lose | Runs through WhatsApp's own approved channel |
| Setup | Link a number by QR code or pairing code, no third party | Twilio account and WhatsApp Business API approval |
| Best for | Prototyping, personal or low-stakes bots | Production, customer-facing deployments |

## License

MIT © [Diego Alto](https://github.com/diegoaltoworks)
