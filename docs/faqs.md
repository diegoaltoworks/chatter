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

You could swap OpenAI/Turso for alternatives, but Chatter currently only supports these providers out of the box.

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
   - Chunks are passed as context to GPT-4
   - GPT-4 generates response using context

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

In your configuration:

```typescript
{
  branding: {
    publicPrimaryColor: '#2563eb',   // Blue
    privatePrimaryColor: '#7c3aed'   // Purple
  }
}
```

Or use theme options in the widget:

```javascript
new Chatter.ChatButton({
  theme: {
    primaryColor: '#2563eb'
  }
});
```

### Can I customize the widget appearance?

Yes! Use theme options:

```javascript
new Chatter.ChatButton({
  theme: {
    primaryColor: '#2563eb',
    fontFamily: 'system-ui, sans-serif',
    borderRadius: '12px',
    buttonSize: '60px'
  }
});
```

For deeper customization, you can override CSS classes (see widget source).

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

Or set via environment variables:
```bash
RATE_LIMIT_RPM_PUBLIC=100
RATE_LIMIT_RPM_PRIVATE=200
```

### Environment variable not found

**Check**:
1. `.env` file exists in project root
2. Variable names match exactly (case-sensitive)
3. No quotes needed in `.env` file (unless value has spaces)
4. Restart server after changing `.env`

For production, ensure secrets are configured in your platform (Secret Manager, environment variables, etc.).

### CORS errors in browser

**Enable CORS in server config**:

```typescript
{
  server: {
    cors: true  // Enables CORS for all origins
  }
}
```

Or configure specific origins:

```typescript
{
  server: {
    cors: {
      origin: ['https://example.com', 'https://app.example.com']
    }
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
- **Turso**: Free tier → $5/mo → scales with usage
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
- 💬 [GitHub Discussions](https://github.com/diegoaltoworks/chatter/discussions)
- 🐛 [Report Issues](https://github.com/diegoaltoworks/chatter/issues)
