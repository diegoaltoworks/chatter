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
