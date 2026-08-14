# Server Setup

This guide walks through setting up and configuring a Chatter server.

## Installation

```bash
npm install @diegoaltoworks/chatter
# or
bun add @diegoaltoworks/chatter
```

## Basic Server Setup

Create a simple server by providing configuration to `createServer`:

```typescript
import { createServer } from '@diegoaltoworks/chatter';

const app = await createServer({
  bot: {
    name: 'MyBot',
    personName: 'Your Name',
    publicUrl: 'https://mybot.example.com',
    description: 'AI assistant for my website'
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY
  },
  database: {
    url: process.env.TURSO_URL,
    authToken: process.env.TURSO_AUTH_TOKEN
  },
  auth: {
    secret: process.env.CHATTER_SECRET  // For JWT-based API keys
  },
  knowledgeDir: './knowledge',
  promptsDir: './prompts'
});

// Start server (Bun example)
Bun.serve({
  port: 8181,
  fetch: app.fetch
});
```

## Configuration

### Bot Identity

Configure your bot's identity and branding:

```typescript
{
  bot: {
    name: 'MyBot',              // Bot's name
    personName: 'My Company',   // Your company/person name
    publicUrl: 'https://bot.example.com',
    description: 'AI assistant for My Company'
  },
  branding: {
    publicPrimaryColor: '#2563eb',   // Public chat theme color
    privatePrimaryColor: '#7c3aed'   // Private chat theme color
  }
}
```

### Chat UI

Customize the chat interface:

```typescript
{
  chat: {
    publicTitle: 'Chat with us',
    publicSubtitle: 'Ask us anything!',
    privateTitle: 'Staff Chat',
    privateSubtitle: 'Internal assistant'
  }
}
```

### Paths

Specify where your content lives:

```typescript
{
  knowledgeDir: './config/knowledge',  // Markdown files for RAG
  promptsDir: './config/prompts',      // System prompts
  publicDir: './public'                // Static files
}
```

### Features

Enable or disable features:

```typescript
{
  features: {
    enablePublicChat: true,    // Public chat endpoint
    enablePrivateChat: true,   // Private/authenticated chat
    enableDemoRoutes: true     // Demo pages (secured with rate limiting)
  }
}
```

### Rate Limiting

Set requests per minute limits:

```typescript
{
  rateLimit: {
    public: 60,    // Requests per minute for public chat
    private: 120   // Requests per minute for private chat
  }
}
```

### Brain

Replace the completion call on every chat surface with your own answer
function — an agent framework, a graph runtime, a remote service — while
Chatter keeps retrieval, prompt assembly, auth, rate limiting, transports and
output guardrails:

```typescript
{
  answerFn: async ({ system, messages, mode, sender }) => {
    const answer = await myAgent.invoke({ system, messages });
    return answer;   // string, or { content, usage }
  }
}
```

Omit it to use the built-in OpenAI completion. See
[integrations.md](./integrations.md) for the streaming behaviour and the
programmatic equivalents.

### Retrieval Scope

Gate knowledge buckets per caller. Every chat surface consults the hook with
the pipeline mode and, where it knows one, the sender's identity:

```typescript
{
  bucketsFor: async ({ mode, sender }) => {
    if (!sender) return undefined;              // keep the mode defaults
    return (await isStaff(sender)) ? ["base", "private"] : ["base", "public"];
  }
}
```

Omit it and each mode retrieves from `base` plus its own bucket. For a caller
the surface could not identify, the hook's answer is filtered down to those
same defaults, so it can narrow retrieval but never widen it — private
knowledge stays out of reach of the public pipeline. See
[integrations.md](./integrations.md) for the full rules, which surfaces consult
the hook, and the `resolveBuckets` helper channels and custom routes should
use.

### Custom Routes

Custom routes receive the same dependencies the built-in route factories use:

```typescript
{
  customRoutes: (app, deps) => {
    // deps.client         OpenAI client
    // deps.store          VectorStore (retrieval)
    // deps.db             libsql database client
    // deps.config         the resolved ChatterConfig
    // deps.prompts        PromptLoader
    // deps.apiKeyManager  API key manager, when configured
    // deps.senders        ChannelSenderRegistry channels register into

    app.get("/my-route", async (c) => {
      const rows = await deps.db.execute("SELECT count(*) AS n FROM chunks");
      return c.json({ chunks: rows.rows[0].n });
    });
  }
}
```

`deps.db` is the ready libsql client the server opened for the vector store.
Custom routes should use it rather than calling `createClient` again — the
process then holds one connection to the database instead of one per consumer.

Constructing a `VectorStore` yourself follows the same rule: pass an existing
client instead of credentials when one is already open.

```typescript
import { createClient } from "@libsql/client";
import { VectorStore } from "@diegoaltoworks/chatter";

const db = createClient({ url, authToken });
const store = new VectorStore(openai, { databaseClient: db, knowledgeDir });
await store.build();
```

Passing `databaseUrl` / `databaseAuthToken` instead makes the store open its
own connection; either way the client it ends up using is available as
`store.db`.

#### Async mounting

`customRoutes` may be async, and `createServer` awaits it. Set-up the routes
depend on — schema migrations, plugin registries, connecting to a transport —
can therefore be done inline, and the app is only handed back once it has
finished. There is no need for a readiness flag that handlers re-check on every
request:

```typescript
{
  customRoutes: async (app, deps) => {
    await deps.db.execute("CREATE TABLE IF NOT EXISTS my_plugin_state (...)");
    const registry = await loadPluginRegistry(deps);

    app.get("/my-route", (c) => c.json(registry.summary()));
  }
}
```

Synchronous functions keep working unchanged, including expression-bodied ones
that return the app for chaining. If the mount throws or rejects, `createServer`
rejects with that error rather than returning a half-mounted app, so a failed
migration fails start-up instead of surfacing later as broken routes.

### Channels

Attach transports (a WhatsApp client, or any future channel) that plug into
the same server without owning their own auth, rate limiting, or chat
pipeline:

```typescript
{
  channels: [myChannel]
}
```

A channel is anything matching the `Channel` SPI — `{ name, start(deps), stop?() }`.
`createServer` starts every configured channel after routes (and
`customRoutes`) are mounted, with the same `deps` custom routes receive
(including `deps.senders`, below), so a channel can call
`prepareChat`/`answerFn`, share `deps.db`, etc. A channel that throws on
`start` is logged and skipped; the server and the other channels keep
running. `start(deps)` also works when called directly, without
`createServer`, for standalone use (a pairing script, a one-off worker) —
just return once the transport is *initiated* (a socket opened), not once a
slow handshake or pairing flow completes, since `createServer` awaits it
before the app starts serving requests.

#### Shutdown

`createServer` never installs its own process signal handlers or calls
`process.exit` — a library doing that would race a host's own shutdown logic
(draining in-flight requests, closing other resources) and override its exit
code. Instead the returned app carries a `stopChannels()` disposer that stops
every channel `createServer` started; wire it into whatever shutdown path the
host already has:

```typescript
const app = await createServer(config);

process.on("SIGTERM", async () => {
  await app.stopChannels();
  process.exit(0);
});
```

A channel's `stop()` throwing (sync or async) is caught per-channel, so one
misbehaving channel can't block the others from cleaning up.

#### Sending without a transport

Brain-side features (a scheduler, the flows engine) send outbound messages by
channel name without importing a transport, through the
`ChannelSenderRegistry` every channel is started with as `deps.senders`. A
channel registers itself on start:

```typescript
const myChannel: Channel = {
  name: "my-transport",
  start(deps) {
    deps.senders.register("my-transport", {
      sendText: (chatId, text) => mySocket.send(chatId, text),
    });
  },
};
```

and any custom route (or another channel) can then reach it:

```typescript
customRoutes: (app, deps) => {
  app.post("/notify", async (c) => {
    const ok = await deps.senders.sendText("my-transport", "some-chat-id", "hi");
    return c.json({ sent: ok });
  });
};
```

`sendText`/`sendVoice`/`sendMedia` all resolve to `false` — never throw — when
the name is unregistered, the channel omits that capability, or the
underlying send fails.

The full channel toolkit — the `Channel` type, the channel-agnostic reply
gates (allowlist, mute/unmute, rate limits, cross-session loop guard), and
`createSenderRegistry` — also lives behind the `./channels` subpath for
transports that want it without pulling in the rest of the core package:

```typescript
import { createSenderRegistry, decideChannelAction } from '@diegoaltoworks/chatter/channels';
```

A built-in WhatsApp transport ships behind `./whatsapp` and dogfoods this
same SPI — see [WhatsApp Channel](./channels.md) for setup, pairing, and its
ToS warning.

### Authentication

#### API Key Secret (Required for Public Chat)

Set a secret for signing/verifying JWT-based API keys:

```typescript
{
  auth: {
    secret: process.env.CHATTER_SECRET  // Hex string, min 32 chars
  }
}
```

#### Clerk (Optional, for Private Chat)

Configure Clerk authentication:

```typescript
{
  auth: {
    secret: process.env.CHATTER_SECRET,
    clerk: {
      publishableKey: process.env.CLERK_PUBLISHABLE_KEY,
      frontendUrl: process.env.CLERK_FRONTEND_URL
    },
    jwt: {
      jwksUrl: process.env.CLERK_JWKS_URL,
      issuer: process.env.CLERK_ISSUER
    }
  }
}
```

#### Custom JWT Provider (Alternative to Clerk)

Use your own JWT authentication:

```typescript
{
  auth: {
    secret: process.env.CHATTER_SECRET,
    jwt: {
      jwksUrl: process.env.JWT_JWKS_URL,  // Your JWKS endpoint
      issuer: process.env.JWT_ISSUER,
      audience: process.env.JWT_AUDIENCE  // Optional
    }
  }
}
```

## Directory Structure

### Knowledge Base

Create a `knowledge/` directory with markdown files:

```
knowledge/
├── base/           # Shared across public & private
│   └── about.md
├── public/         # Public chat only
│   ├── faqs.md
│   └── pricing.md
└── private/        # Private chat only (requires JWT)
    └── runbook.md
```

**How it works:**
1. On startup, all `.md` files are chunked (~900 chars)
2. Chunks are embedded using OpenAI
3. Embeddings are stored in Turso vector database
4. On query, relevant chunks are retrieved via cosine similarity
5. Context is passed to GPT-4 for response generation

**Knowledge updates:**
- The system tracks file hashes
- Only changed files are re-embedded
- No need to rebuild entire database on updates

### System Prompts

Create a `prompts/` directory with text files:

```
prompts/
├── base.txt        # Core rules for all chats
├── public.txt      # Tone for customer interactions
└── private.txt     # Tone for internal users
```

**Template variables** available in prompts:
- `{{botName}}` - Your bot's name
- `{{personName}}` - Company/person name
- `{{personFirstName}}` - First name only

**Example base.txt:**
```
You are {{botName}}, an AI assistant for {{personName}}.

Core rules:
- Be helpful, friendly, and professional
- Use the provided knowledge base to answer questions
- If you don't know something, say so honestly
```

## Environment Variables

Create a `.env` file:

```bash
# OpenAI API (required)
OPENAI_API_KEY=sk-...

# Turso Database (required)
TURSO_URL=libsql://your-db.turso.io
TURSO_AUTH_TOKEN=...

# Server
PORT=8181
NODE_ENV=development

# API Key Secret (required for public chat)
CHATTER_SECRET=your-secret-hex-string

# Clerk (optional, for private chat)
CLERK_PUBLISHABLE_KEY=pk_live_...
CLERK_FRONTEND_URL=https://clerk.example.com
CLERK_JWKS_URL=https://clerk.example.com/.well-known/jwks.json
CLERK_ISSUER=https://clerk.example.com

# Rate Limits
RATE_LIMIT_RPM_PUBLIC=60
RATE_LIMIT_RPM_PRIVATE=120
```

## API Key Management

Chatter includes a built-in API key management system using JWT tokens.

### CLI Tool

Generate API keys using the CLI:

```bash
# Create a key that expires in 1 year
npx chatter create-apikey --name "mobile-app" --expires-in 365d

# Create a short-lived test key
npx chatter create-apikey --name "test" --expires-in 1h
```

Output:
```
✅ API Key generated successfully!

   Name:       mobile-app
   ID:         550e8400-e29b-41d4-a716-446655440000
   Expires:    2025-11-16T12:00:00.000Z (365d)

   API Key:
   eyJhbGciOiJIUzI1NiJ9.eyJuYW1lIjoibW9iaWxlLWFwcCIsInR5cGUiOiJhcGlfa2V5Ii...
```

### Programmatic Usage

```typescript
import { ApiKeyManager } from '@diegoaltoworks/chatter';

const manager = new ApiKeyManager(process.env.CHATTER_SECRET);

// Create a key
const apiKey = await manager.create({
  name: 'dashboard',
  expiresIn: '90d'
});

// Verify a key
const result = await manager.verify(apiKey);
if (result.valid) {
  console.log('Authorized:', result.payload.name);
}
```

## Running Locally

### Development Mode

With watch mode for auto-reload:

```bash
bun run --watch src/index.ts
```

Or add to `package.json`:
```json
{
  "scripts": {
    "dev": "bun run --watch src/index.ts"
  }
}
```

Then run:
```bash
bun run dev
```

### Production Mode

Build and run:

```bash
# Build
bun build src/index.ts --outdir dist --target bun

# Run
bun dist/index.js
```

Or with package.json scripts:
```json
{
  "scripts": {
    "build": "bun build src/index.ts --outdir dist --target bun",
    "start": "bun dist/index.js"
  }
}
```

Then:
```bash
bun run build
bun run start
```

## Architecture

```
┌─────────────┐
│   Browser   │
│  (Widget)   │
└──────┬──────┘
       │ HTTPS
       ▼
┌─────────────┐
│   Chatter   │◄─── knowledge/
│   Server    │◄─── prompts/
│   (Hono)    │
└──────┬──────┘
       │
       ├──────► OpenAI (GPT-4 + Embeddings)
       │
       └──────► Turso (Vector DB)
```

## Request Flow

1. User sends message via chat widget
2. Server authenticates request (API key or JWT)
3. Server embeds the query using OpenAI
4. Relevant knowledge chunks are retrieved from Turso
5. System prompt + context + user message → GPT-4
6. Response is streamed back to the client
7. Client displays the message in real-time

## Authentication Modes

### Public Mode
- API key authentication (JWT-based)
- Rate limited by IP address
- Access to `base/` + `public/` knowledge
- Use for: Customer support, public websites

### Private Mode
- JWT authentication (JWKS or Clerk)
- Rate limited by JWT subject
- Access to `base/` + `private/` knowledge
- Use for: Internal tools, authenticated users

## Next Steps

- [Deployment Guide](./deployment.md) - Deploy to production
- [Client Setup](./client.md) - Integrate chat widgets
- [FAQs](./faqs.md) - Common questions and troubleshooting
