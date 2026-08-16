# Frequently Asked Questions

## General

### Can I use this in production?

Yes! Chatter is production-ready. The [chatter-demo](https://github.com/diegoaltoworks/chatter-demo) repository shows a complete production implementation with deployment examples.

### Do I need to modify the source code?

No. Chatter is designed to be configured, not modified. All customization happens through:
- Configuration objects
- Knowledge base markdown files
- System prompt text files
- Environment variables

### How much does it cost to run?

Typical monthly costs for a small-to-medium deployment:

| Service | Cost |
|---------|------|
| OpenAI API | $5-50 (usage-based) |
| Turso Database | Free or $5+ |
| Clerk Auth | Free or $25+ |
| Hosting | Free-$20 |
| **Total** | **$5-100/month** |

Main variables:
- Number of messages
- Knowledge base size
- Number of users
- Hosting platform

### Can I self-host everything?

Partially. You can self-host the Chatter server on any VPS or container platform. However:

**External services required**:
- OpenAI (for embeddings and completions)
- Turso (for vector database)

**Optional external services**:
- Clerk (for authentication)

Both required services are replaceable through seams, not source edits:

- **Turso**: set `config.retriever` to any object implementing `Retriever` and
  the built-in `VectorStore` (and therefore `config.database`) drops out
  entirely - pgvector, sqlite-vec, Qdrant, whatever you run. See
  [Adding a retriever](./patterns/adding-a-retriever.md).
- **OpenAI embeddings**: `VectorStore` takes an `Embedder`
  (`(input: string[]) => Promise<number[][]>`) as its first constructor
  argument. Pass your own instead of `createOpenAIEmbedder(client)` to keep
  Turso storage with a local or third-party embedding model.
- **OpenAI completions**: set the `answerFn` brain hook to answer from your own
  model. See [Architecture](./ARCHITECTURE.md).

## Platform Compatibility

### Does it work on Vercel?

No. Vercel doesn't support Bun runtime and is optimized for serverless functions, not long-running processes.

**Use instead**: Google Cloud Run, Fly.io, Railway, DigitalOcean, or any VPS.

### Does it work on AWS Lambda?

No. Lambda is serverless and designed for short-lived functions. Chatter needs persistent processes.

**Use instead**: AWS ECS/Fargate (container platforms).

### What platforms are supported?

**✅ Supported**:
- Google Cloud Run, Fly.io, Railway
- AWS ECS/Fargate, Azure Container Apps
- DigitalOcean App Platform
- Any VPS with Docker

**❌ Not Supported**:
- Vercel, Netlify (no Bun runtime)
- AWS Lambda, Cloudflare Workers (serverless)

See [Deployment Guide](./deployment.md) for platform-specific instructions.

## Knowledge Base & RAG

### How does RAG (Retrieval-Augmented Generation) work?

1. Your markdown files are split into chunks (~900 chars)
2. Each chunk is embedded using OpenAI's embedding model
3. Embeddings are stored in Turso vector database
4. When a user asks a question:
   - Question is embedded
   - Similar chunks are retrieved (cosine similarity)
   - Chunks are passed as context to the configured model (`config.openai.model`)
   - The model generates a response using that context

Steps 2-3 describe the default `VectorStore`. Set `config.retriever` and your
backend answers the retrieval step instead, with no change to any chat surface;
see [Adding a retriever](./patterns/adding-a-retriever.md).

### How do I update the knowledge base?

Just edit or add markdown files in your `knowledge/` directory. On next startup, Chatter will:
- Detect changed files (using content hashes)
- Only re-embed modified files
- Keep existing embeddings for unchanged files

No need to rebuild the entire database.

### What file format should I use?

Markdown (`.md`) files are recommended. You can include:
- Headings (`#`, `##`, `###`)
- Lists (bullet and numbered)
- Code blocks
- Links
- Bold/italic text

Chatter will chunk and embed the content intelligently.

### How big can my knowledge base be?

**Technical limits**: No hard limits, but consider:
- OpenAI embedding costs (~$0.10 per 1M tokens)
- Turso storage limits (free tier: 1GB)
- Startup time (more files = longer initial embedding)

**Practical recommendation**: 100-1000 markdown files works well.

### Can I use different knowledge for public vs private chat?

Yes! Organize your knowledge base like this:

```
knowledge/
├── base/      # Shared (both public and private)
├── public/    # Public chat only
└── private/   # Private chat only (authenticated users)
```

Private chat users get access to `base/` + `private/` knowledge.
Public users only get `base/` + `public/` knowledge.

## Authentication

### What's the difference between public and private mode?

**Public Mode**:
- API key authentication
- Rate limited by IP address
- Access to public knowledge base
- No user account required
- Use for: Customer support, public websites

**Private Mode**:
- JWT authentication (via Clerk or custom provider)
- Rate limited by user ID
- Access to private knowledge base
- Requires authentication
- Use for: Internal tools, authenticated users

### How do I create API keys?

Use the CLI tool:

```bash
npx chatter create-apikey --name "my-app" --expires-in 365d
```

Or programmatically:

```typescript
import { ApiKeyManager } from '@diegoaltoworks/chatter';

const manager = new ApiKeyManager(process.env.CHATTER_SECRET);
const key = await manager.create({ name: 'my-app', expiresIn: '365d' });
```

### Can I use my own authentication system?

Yes! Chatter supports any JWT-based authentication. Configure with:

```typescript
{
  auth: {
    jwt: {
      jwksUrl: 'https://your-auth.com/.well-known/jwks.json',
      issuer: 'https://your-auth.com/',
      audience: 'your-api'  // optional
    }
  }
}
```

Your JWT tokens must include standard claims (`sub`, `iss`, `exp`).

### Do I need Clerk?

No. Clerk is optional and only needed for private chat mode. You can:

1. **Use only public mode** - No Clerk needed, just API keys
2. **Use custom JWT provider** - Configure your own auth system
3. **Use Clerk** - Easiest for private mode with user management

## Customization

### How do I change the bot's personality?

Edit the files in your `prompts/` directory:

- `base.txt` - Core rules for all interactions
- `public.txt` - Tone for public chat
- `private.txt` - Tone for private chat

Use template variables:
- `{{botName}}` - Your bot's name
- `{{personName}}` - Company/person name

### How do I change the colors?

With CSS. The widgets ship classes prefixed `chatter-ui-`; load your own
stylesheet after `/chatter.css` and override them:

```css
.chatter-ui-chat-button { background: #2563eb; }
.chatter-ui-chat-header { background: #2563eb; }
```

`branding.publicPrimaryColor` / `branding.privatePrimaryColor` in the server
config are published on `GET /config` so your own page can read your palette.
Nothing shipped applies them to the widgets.

### Can I customize the widget appearance?

Yes, via the `chatter-ui-` CSS classes above. `ChatButton` also takes `styles`,
applied inline to the floating button as DOM style properties:

```javascript
new Chatter.ChatButton({
  host: 'bot.example.com',
  mode: 'public',
  apiKey: '...',
  styles: {
    backgroundColor: '#2563eb',
    borderRadius: '12px',
    width: '60px',
    height: '60px'
  }
});
```

There is no `theme` option. See [Client Setup](./client.md#styling).

## Troubleshooting

### Chat widget not loading

**Checklist**:
1. Is your Chatter server running?
2. Is the server URL correct in widget config?
3. Check browser console for errors
4. Verify CORS is enabled on server
5. Check that `/chatter.js` and `/chatter.css` are accessible

### "Unauthorized" errors

**Public mode**:
- Verify API key is valid (not expired)
- Check API key is passed to widget correctly
- Ensure `CHATTER_SECRET` matches on server

**Private mode**:
- Verify user is signed in (Clerk or custom auth)
- Check JWT configuration on server
- Verify `CLERK_JWKS_URL` and `CLERK_ISSUER` are correct

### Knowledge base not updating

**Solutions**:
1. Restart the server (knowledge is loaded on startup)
2. Check file permissions on `knowledge/` directory
3. Verify markdown files are valid UTF-8
4. Check logs for embedding errors

### Slow responses

**Possible causes**:
- Large knowledge base (many chunks to search)
- High OpenAI API latency
- Network issues

**Solutions**:
- Use smaller, more focused knowledge base
- Cache frequently asked questions
- Consider upgrading hosting plan

### Rate limit errors

**Adjust in configuration**:

```typescript
{
  rateLimit: {
    public: 60,   // Increase for more requests/minute
    private: 120
  }
}
```

Rate limits are config-only; there are no `RATE_LIMIT_*` environment variables.
Read your own env in the object you pass to `createServer` if you want them
tunable per deployment.

### Environment variable not found

**Check**:
1. `.env` file exists in project root
2. Variable names match exactly (case-sensitive)
3. No quotes needed in `.env` file (unless value has spaces)
4. Restart server after changing `.env`

For production, ensure secrets are configured in your platform (Secret Manager, environment variables, etc.).

### CORS errors in browser

CORS is on by default. `server.cors` is a boolean switch, not an options
object - set it to `false` to turn the middleware off entirely:

```typescript
{
  server: {
    cors: true  // Default. false removes the CORS middleware.
  }
}
```

The allowed origins live alongside it, in `server.allowedOrigins`. Unset, it
defaults to `["*"]`:

```typescript
{
  server: {
    cors: true,
    allowedOrigins: ['https://example.com', 'https://app.example.com']
  }
}
```

## Performance

### How many concurrent users can it handle?

Depends on your hosting platform and configuration:

**Typical numbers**:
- **VPS (2 CPU, 4GB RAM)**: 50-100 concurrent users
- **Cloud Run (auto-scaling)**: 1000+ concurrent users
- **Fly.io (multiple regions)**: 500+ concurrent users

Bottlenecks are usually:
1. OpenAI API rate limits
2. Database connections
3. Memory for embedding searches

### How can I improve performance?

**Optimizations**:
1. **Cache common queries** - Reduce OpenAI API calls
2. **Smaller knowledge base** - Faster embedding searches
3. **Higher rate limits** - More concurrent requests
4. **Better hosting** - More CPU/memory
5. **Multiple regions** - Reduce latency for global users

### What about costs at scale?

**Cost scaling**:
- **OpenAI API**: ~$0.03 per conversation (GPT-4o-mini)
- **Turso**: Free tier -> $5/mo -> scales with usage
- **Hosting**: Varies by platform (many offer generous free tiers)

**Cost optimization**:
- Use GPT-4o-mini instead of GPT-4 (20x cheaper)
- Implement response caching
- Set appropriate rate limits
- Monitor usage dashboards

## Development

### How do I run tests?

```bash
bun test
```

For coverage:
```bash
bun test --coverage
```

### How do I contribute?

Contributions welcome! See:
- [Chatter repository](https://github.com/diegoaltoworks/chatter)
- [Chatter Demo repository](https://github.com/diegoaltoworks/chatter-demo)

### Can I use this with Next.js/React/Vue?

Yes! Chatter widgets work with any framework:

**Next.js**: Use in client component (`'use client'`)
**React**: Use in `useEffect` hook
**Vue**: Use in `onMounted` hook
**Vanilla JS**: Just add script tags

See [Client Setup](./client.md) for framework-specific examples.

## Still Have Questions?

- 📚 [Server Setup](./server.md)
- 🚀 [Deployment Guide](./deployment.md)
- 🎨 [Client Setup](./client.md)
- 💬 [Ask a question](https://github.com/diegoaltoworks/chatter/issues) - Discussions are not enabled; open an issue
- 🐛 [Report Issues](https://github.com/diegoaltoworks/chatter/issues)
