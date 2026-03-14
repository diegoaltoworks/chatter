# Chatter Examples

Complete examples showing different ways to use Chatter.

## Quick Start

All examples require environment variables:
```bash
export OPENAI_API_KEY="sk-..."
export TURSO_URL="libsql://..."
export TURSO_AUTH_TOKEN="..."
export CHATTER_SECRET="your-secret-key"  # For HTTP servers
```

## Examples

### 1. HTTP Server (Basic)
**File:** `http-server-basic.ts`

Basic Chatter HTTP server with public and private chat endpoints.

```bash
bun run examples/http-server-basic.ts
```

**Features:**
- Public chat endpoint (`/api/public/chat`)
- Private chat endpoint (`/api/private/chat`)
- Health check and config endpoints
- Rate limiting
- API key authentication

**Use when:**
- You want a production-ready HTTP API
- Need both public and authenticated endpoints
- Want to embed chat widgets in your website

---

### 2. HTTP Server with Clerk
**File:** `http-server-with-clerk.ts`

HTTP server with Clerk authentication for private endpoints.

```bash
# Additional env vars needed:
export CLERK_PUBLISHABLE_KEY="pk_..."
export CLERK_FRONTEND_URL="https://..."

bun run examples/http-server-with-clerk.ts
```

**Features:**
- Clerk JWT validation for private endpoint
- Custom branding colors
- Custom chat titles and subtitles

**Use when:**
- You need user authentication
- Want to integrate with Clerk
- Building multi-tenant applications

---

### 3. MCP Server
**File:** `mcp-server-example.ts`

Model Context Protocol server for Claude Desktop and other MCP clients.

```bash
bun run examples/mcp-server-example.ts
```

**Features:**
- STDIO transport for local MCP clients
- Tools for public and private knowledge
- RAG-powered responses

**Use when:**
- Integrating with Claude Desktop
- Building MCP-compatible tools
- Need local AI assistant

**Claude Desktop Config:**
```json
{
  "mcpServers": {
    "chatter": {
      "command": "bun",
      "args": ["run", "/path/to/examples/mcp-server-example.ts"],
      "env": {
        "OPENAI_API_KEY": "sk-...",
        "TURSO_URL": "libsql://...",
        "TURSO_AUTH_TOKEN": "..."
      }
    }
  }
}
```

---

### 4. API Client Usage
**File:** `api-client-usage.ts`

Shows how to call Chatter HTTP API from code.

```bash
# 1. Start a server (in another terminal)
bun run examples/http-server-basic.ts

# 2. Create an API key
export CHATTER_SECRET="your-secret"
bun bin/create-apikey.ts --name "my-client" --expires-in 365d

# 3. Run the client
export CHATTER_API_KEY="<key-from-step-2>"
bun run examples/api-client-usage.ts
```

**Features:**
- Simple single-message chat
- Conversation with history
- Streaming responses
- Error handling

**Use when:**
- Building client applications
- Testing your API
- Integrating with other services

---

### 5. Programmatic RAG
**File:** `programmatic-rag.ts`

Use Chatter's core modules directly without HTTP server.

```bash
bun run examples/programmatic-rag.ts
```

**Features:**
- Direct use of VectorStore and PromptLoader
- Knowledge base queries
- Multi-turn conversations
- No HTTP overhead

**Use when:**
- Building CLI tools
- Batch processing
- Custom integrations
- You don't need an HTTP API

---

## Common Patterns

### Creating API Keys
```bash
# Set secret first
export CHATTER_SECRET="your-secret-key"

# Create a key
bun bin/create-apikey.ts --name "my-app" --expires-in 365d
```

### Knowledge Base Structure
```
knowledge/
├── base/           # Shared knowledge
│   └── company.md
├── public/         # Public-facing FAQs
│   ├── faq.md
│   └── policies.md
└── private/        # Internal docs
    └── internal.md
```

### Prompts Structure
```
prompts/
├── base-system.txt     # Base system rules
├── public-persona.txt  # Public-facing personality
└── private-persona.txt # Internal assistant personality
```

## Testing Examples

Run TypeScript directly with Bun:
```bash
bun run examples/http-server-basic.ts
```

Or build first:
```bash
bun build examples/http-server-basic.ts --outdir examples/dist
node examples/dist/http-server-basic.js
```

## Environment Variables Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENAI_API_KEY` | Yes | OpenAI API key |
| `TURSO_URL` | Yes | Turso database URL |
| `TURSO_AUTH_TOKEN` | Yes | Turso auth token |
| `CHATTER_SECRET` | HTTP only | Secret for API key generation |
| `CLERK_PUBLISHABLE_KEY` | Clerk only | Clerk public key |
| `CLERK_FRONTEND_URL` | Clerk only | Clerk frontend URL |
| `CHATTER_URL` | Client only | Server URL (default: localhost:8181) |
| `CHATTER_API_KEY` | Client only | API key for authentication |

## Next Steps

1. Choose the example that matches your use case
2. Set up required environment variables
3. Create your knowledge base in `./knowledge`
4. Create your prompts in `./prompts`
5. Run the example
6. Customize to your needs

For more information, see:
- [Server Setup Guide](../docs/server.md)
- [Client Integration Guide](../docs/client.md)
- [Deployment Guide](../docs/deployment.md)
