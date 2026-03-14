# Chatter

<div align="center">

**Embeddable AI chatbot framework with RAG, authentication, and customizable widgets**

[![NPM Version](https://img.shields.io/npm/v/@diegoaltoworks/chatter)](https://www.npmjs.com/package/@diegoaltoworks/chatter)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![CI](https://github.com/diegoaltoworks/chatter/actions/workflows/ci.yml/badge.svg)](https://github.com/diegoaltoworks/chatter/actions/workflows/ci.yml)
[![Demo](https://img.shields.io/badge/demo-chatter--demo-blue)](https://github.com/diegoaltoworks/chatter-demo)

[Features](#features) • [Quick Start](#quick-start) • [Documentation](#documentation) • [Demo](#demo)

</div>

## Features

- 🤖 **RAG-Powered**: Retrieval-Augmented Generation using OpenAI embeddings and Turso vector database
- 🎨 **Customizable Widgets**: Pre-built chat components (ChatBot, Chat, ChatButton) with full styling control
- 🔐 **Built-in API Key Management**: JWT-based API keys with CLI tool for easy creation
- 🔑 **Authentication Ready**: Built-in support for JWT, Clerk, and custom auth providers
- 📱 **Mobile Optimized**: Responsive design with iOS/Android-specific fixes
- ⚡ **High Performance**: Built on Hono with streaming support
- 🛡️ **Security First**: Rate limiting, CORS, referrer checking, and input guardrails
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
npx chatter create-apikey --name "my-app" --expires-in 365d
```

**Requirements:** OpenAI API key, Turso database, Bun runtime. See [Requirements Guide](./docs/requirements.md) for setup instructions.

## Examples

**[📁 Complete Examples](./examples/)** - Ready-to-run examples for all use cases:

- **[HTTP Server (Basic)](./examples/http-server-basic.ts)** - Production-ready HTTP API
- **[HTTP Server + Clerk](./examples/http-server-with-clerk.ts)** - With authentication
- **[MCP Server](./examples/mcp-server-example.ts)** - For Claude Desktop integration
- **[API Client](./examples/api-client-usage.ts)** - Call Chatter from code
- **[Programmatic RAG](./examples/programmatic-rag.ts)** - Use core modules directly

## Documentation

Complete guides for setup, deployment, and integration:

- **[Requirements](./docs/requirements.md)** - OpenAI, Turso, Clerk setup and pricing
- **[Server Setup](./docs/server.md)** - Configuration, knowledge base, prompts, API keys
- **[Client Integration](./docs/client.md)** - Widgets, React components, theming
- **[Deployment](./docs/deployment.md)** - Google Cloud Run, Fly.io, Railway, VPS
- **[Testing](./docs/testing.md)** - Comprehensive testing guide (254 tests, 98% coverage)
- **[Code Quality](./docs/CODE_QUALITY.md)** - Security assessment and architecture review
- **[FAQs](./docs/faqs.md)** - Troubleshooting and common questions

## Demo

**🎯 [View Live Demo & Complete Implementation Example](https://github.com/diegoaltoworks/chatter-demo)**

The [chatter-demo](https://github.com/diegoaltoworks/chatter-demo) repository contains a complete, production-ready implementation showing:

- Full server setup with custom configuration
- 8 live demo implementations (Widget/React × Button/Inline × Public/Private)
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

Use Chatter as a Model Context Protocol (MCP) server to expose your chatbot to Claude Desktop, VS Code extensions, and other MCP-compatible tools:

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
    console: true,  // JSON logs to stdout (default: true)
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
- Return token usage and cost estimates in response metadata
- Use RAG-powered context retrieval from your knowledge base
- Can be customized with different names and descriptions
- Can be individually enabled/disabled
- Optional per-tool rate limiting

**Features:**
- **Conversation ID Tracking**: Pass `conversationId` parameter to maintain session continuity across tool calls
- **Cost Tracking**: Every response includes token usage (prompt/completion/total) and estimated USD cost
- **Rate Limiting**: Optional per-tool rate limiting (requests per minute) to control API usage
- **Observability**: Comprehensive logging with conversation tracking and cost data

## Plugins

### Talker — Voice Calls & SMS

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

One server, one port — web chat, phone calls, and SMS. See the [Talker README](https://github.com/diegoaltoworks/talker) for full documentation.

## License

MIT © [Diego Alto](https://github.com/diegoaltoworks)
