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

**Cost**: Chatter defaults to `gpt-4o` for completions (`DEFAULT_MODEL`,
overridable with `config.openai.model`) and pays per embedded token when it
builds the knowledge base. What that costs depends on the model you pick and
your traffic, so read the current numbers off OpenAI's pricing page above
rather than a figure copied into these docs.

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

**Pricing**: Has a free tier a small deployment fits inside. Limits change; read them off https://turso.tech/pricing.

## Bringing Your Own Retrieval Stack

"Required" above describes the default wiring, not a hard dependency. Both
required services sit behind seams:

- **Replacing Turso.** `config.retriever` accepts any object implementing the
  `Retriever` interface. Set it and the built-in `VectorStore` is never
  constructed, so `config.database` is no longer required either - the server
  fails fast at startup only when *neither* is present. Point it at pgvector,
  sqlite-vec, Qdrant, a managed vector database, or an existing search service.
  Worked example: [Adding a retriever](./patterns/adding-a-retriever.md).
- **Replacing OpenAI embeddings.** The embedder is injected, not hardcoded:
  `new VectorStore(embedder, options)` takes an `Embedder`, typed
  `(input: string[]) => Promise<number[][]>`. `createOpenAIEmbedder(client)` is
  just the shipped adapter. Pass your own to keep Turso storage while embedding
  with a local or third-party model.
- **Replacing OpenAI completions.** The `answerFn` brain hook replaces the
  completion call outright. See [Architecture](./ARCHITECTURE.md).

`Retriever`, `Embedder`, `VectorStore` and `createOpenAIEmbedder` are all
exported from the package root.

## Optional Services

### Clerk (for Private Chat)

**Purpose**: User authentication for private/staff chat mode

**When needed**: Only required if you want to use private chat mode with authenticated users

**Setup**:
1. Sign up: https://clerk.com
2. Create application in Clerk Dashboard
3. Get credentials from Dashboard -> API Keys

**Environment Variables**:
- `CLERK_PUBLISHABLE_KEY` - Frontend publishable key (starts with `pk_...`)
- `CLERK_FRONTEND_URL` - Your Clerk frontend URL (e.g., `https://clerk.example.com`)
- `CLERK_JWKS_URL` - JWKS endpoint (e.g., `https://clerk.example.com/.well-known/jwks.json`)
- `CLERK_ISSUER` - Issuer URL (typically same as frontend URL)

**Pricing**: Has a free tier priced by monthly active users. Limits change; read them off https://clerk.com/pricing.

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

That floor isn't arbitrary: `jose` (the JWT/JWK dependency behind API keys and
JWT auth) ships ESM-only, with no CJS build of its own. Chatter's own CJS
entry points (`require("@diegoaltoworks/chatter")`, the `create-apikey` CLI)
externalise `jose` and `require()` it directly, which only works on a Node
whose `require(esm)` support is unflagged by default - true since Node 22.12
(see the version check in `scripts/verify-node.mjs`). `engines.node:
">=24.0.0"` sits comfortably above that line; pinned to an older Node, the
CJS entry points fail to load `jose`.

Node needs one extra package - [`@hono/node-server`](https://github.com/honojs/node-server),
an optional peer dependency - for both serving the app and serving static
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
`features: { headless: true }` serves no files and needs no adapter - in that
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

## What It Costs To Run

Every dependency below has a usage-based or tiered price that its vendor
changes independently of this project, so the honest answer is a list of what
you pay for rather than a total:

| Service | What you pay for |
|---------|------------------|
| OpenAI API | Completion and embedding tokens, per the model you configure |
| Turso | Rows stored and read, free tier upwards |
| Clerk | Monthly active users, free tier upwards (only if you use it) |
| Hosting | Whatever your persistent-process host charges |

Turso and Clerk both have free tiers a small deployment fits inside; OpenAI
does not.

## Next Steps

Once you have your API keys and credentials:
1. See [Server Setup](./server.md) to configure and run your Chatter server
2. See [Deployment](./deployment.md) to deploy to production
3. See [Client Setup](./client.md) to integrate chat widgets
