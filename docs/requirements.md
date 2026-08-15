# Requirements

Chatter requires a few external services to function. This guide walks through what you need and how to set them up.

## Required Services

### OpenAI

**Purpose**: LLM completions and text embeddings for RAG (Retrieval-Augmented Generation)

**Setup**:
1. Sign up: https://platform.openai.com/signup
2. Get API key: https://platform.openai.com/api-keys
3. Pricing: https://openai.com/pricing

**Environment Variables**:
- `OPENAI_API_KEY` - Your OpenAI API key (starts with `sk-...`)

**Cost Estimate**:
- Embeddings: ~$0.10 per 1M tokens (for building knowledge base)
- Completions: ~$0.03 per 1K tokens (GPT-4o-mini) or ~$3 per 1M tokens for GPT-4
- Typical usage: $5-50/month depending on volume

### Turso

**Purpose**: Vector database for storing and retrieving embeddings

**Setup**:
1. Sign up: https://turso.tech
2. Install Turso CLI:
   ```bash
   curl -sSfL https://get.tur.so/install.sh | bash
   ```
3. Create database:
   ```bash
   turso db create <db-name>
   ```
4. Get connection URL:
   ```bash
   turso db show <db-name> --url
   ```
5. Create auth token:
   ```bash
   turso db tokens create <db-name>
   ```

**Environment Variables**:
- `TURSO_URL` - Database URL (starts with `libsql://...`)
- `TURSO_AUTH_TOKEN` - Authentication token

**Pricing**: Free tier available (500 databases, 1GB storage)

## Optional Services

### Clerk (for Private Chat)

**Purpose**: User authentication for private/staff chat mode

**When needed**: Only required if you want to use private chat mode with authenticated users

**Setup**:
1. Sign up: https://clerk.com
2. Create application in Clerk Dashboard
3. Get credentials from Dashboard → API Keys

**Environment Variables**:
- `CLERK_PUBLISHABLE_KEY` - Frontend publishable key (starts with `pk_...`)
- `CLERK_FRONTEND_URL` - Your Clerk frontend URL (e.g., `https://clerk.example.com`)
- `CLERK_JWKS_URL` - JWKS endpoint (e.g., `https://clerk.example.com/.well-known/jwks.json`)
- `CLERK_ISSUER` - Issuer URL (typically same as frontend URL)

**Pricing**: Free tier available (10,000 monthly active users)

### Custom JWT Provider (Alternative to Clerk)

**Purpose**: Use your own JWT authentication system

**When needed**: If you already have an auth system and want to use it instead of Clerk

**Environment Variables**:
- `JWT_JWKS_URL` - Your JWKS endpoint URL
- `JWT_ISSUER` - Your JWT issuer
- `JWT_AUDIENCE` - Expected audience claim (optional)

## Runtime Requirements

Chatter runs on **Bun >= 1.2** or **Node >= 24**. Both are built, published and
exercised in CI; pick whichever your host already runs.

### Bun

**Installation**:
```bash
curl -fsSL https://bun.sh/install | bash
```

**Why Bun?**:
- Fast startup and execution
- Native TypeScript support
- Built-in test runner
- The runtime Chatter itself is developed and tested on

Serve the app with the built-in server:
```ts
Bun.serve({ port: 8181, fetch: app.fetch });
```

### Node

**Version**: 24 or higher (`engines.node`).

Node needs one extra package — [`@hono/node-server`](https://github.com/honojs/node-server),
an optional peer dependency — for both serving the app and serving static
files:

```bash
npm install @hono/node-server
```

```ts
import { serve } from "@hono/node-server";
serve({ port: 8181, fetch: app.fetch });
```

Chatter picks the matching static-file adapter from the runtime it finds itself
in, so no configuration is needed. A Node server started with
`features: { headless: true }` serves no files and needs no adapter — in that
mode `@hono/node-server` is only required for `serve()` itself.

### Platform Requirements

**Chatter requires long-running server processes.**

**✅ Compatible:**
- Google Cloud Run, Fly.io, Railway, DigitalOcean App Platform
- AWS ECS/Fargate, Azure Container Apps
- Any VPS with Docker (Ubuntu, Debian, etc.)

**❌ NOT Compatible:**
- Vercel, Netlify, AWS Lambda, Cloudflare Workers (serverless platforms)

**Why**: Chatter needs persistent processes for RAG embeddings, session state, and streaming responses.

## Estimated Total Costs

For a typical small-to-medium deployment:

| Service | Monthly Cost |
|---------|-------------|
| OpenAI API | $5-50 (usage-based) |
| Turso | Free (or $5+ for pro features) |
| Clerk | Free (or $25+ for pro features) |
| Hosting | Free-$20 (varies by platform) |
| **Total** | **$5-100/month** |

## Next Steps

Once you have your API keys and credentials:
1. See [Server Setup](./server.md) to configure and run your Chatter server
2. See [Deployment](./deployment.md) to deploy to production
3. See [Client Setup](./client.md) to integrate chat widgets
