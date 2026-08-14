# Chatter Documentation

Welcome to the Chatter documentation! This guide will help you set up and deploy your own AI chatbot with RAG capabilities.

## Quick Navigation

### Getting Started

1. **[Requirements](./requirements.md)** - What you need before starting
   - OpenAI API setup
   - Turso database configuration
   - Clerk authentication (optional)
   - Runtime and platform requirements
   - Cost estimates

2. **[Server Setup](./server.md)** - Configure and run your Chatter server
   - Installation
   - Configuration options
   - Knowledge base setup
   - System prompts
   - API key management
   - Channels (transport SPI, reply gates, sender registry)
   - Running locally

3. **[Client Setup](./client.md)** - Integrate chat widgets into your website
   - Vanilla JavaScript widgets
   - React components
   - Theming and customization
   - Authentication modes
   - Framework integration

4. **[UI Integrations & OpenAI-Compatible API](./integrations.md)** - Bring your own chat UI
   - OpenAI-compatible endpoints (`/v1/chat/completions`)
   - Headless mode (API only, no built-in widget)
   - Programmatic RAG pipeline (no HTTP)
   - Per-caller prompt shaping and role-gated retrieval scope
   - Bringing your own brain (`answerFn`)
   - Deep Chat and assistant-ui sample apps

5. **[Usage Metering](./usage.md)** - Cap what paid features cost per day
   - Per-caller and global daily caps
   - Reserve-once semantics and cache-before-spend ordering
   - Multi-instance-safe Turso store, or bring your own

6. **[Personas](./personas.md)** - Dynamic prompt layers and named greetings
   - Windowed, per-contact persona rolls from a JSON registry
   - Prompt-file loading with template interpolation
   - Content-free greeter and time-context helper

7. **[WhatsApp Channel](./channels.md)** - Link a WhatsApp number as a transport
   - Configuration, pairing (QR and pairing-code modes)
   - Encrypted, multi-session auth state
   - Deploy lease and reconnect behaviour

8. **[Deployment](./deployment.md)** - Deploy to production
   - Platform compatibility
   - Docker deployment
   - Google Cloud Run
   - Fly.io
   - Railway
   - VPS setup
   - Security best practices

9. **[FAQs](./faqs.md)** - Common questions and troubleshooting
   - General questions
   - Platform compatibility
   - Knowledge base and RAG
   - Authentication
   - Customization
   - Performance and scaling

## Documentation Flow

We recommend following the documentation in this order:

```
Requirements → Server Setup → Client Setup → Deployment
                                              ↓
                                            FAQs
```

## Quick Start

If you just want to get started quickly:

```bash
# Install Chatter
npm install @diegoaltoworks/chatter

# Create your server
# (See Server Setup for full configuration)

# Create API key
npx chatter create-apikey --name "my-app" --expires-in 365d

# Integrate widgets
# (See Client Setup for examples)
```

## Live Demo

For a complete working example with source code, see the [Chatter Demo](https://github.com/diegoaltoworks/chatter-demo) repository, which includes:

- Full server implementation
- 8 live demo pages
- Clerk authentication integration
- Deployment configuration
- Knowledge base examples
- System prompt examples

## Key Concepts

### What is Chatter?

Chatter is an embeddable AI chatbot framework with:
- **RAG** (Retrieval-Augmented Generation) for knowledge-based responses
- **Built-in authentication** via API keys, Clerk, or custom JWT
- **Customizable widgets** for any website
- **TypeScript-first** with full type safety

### How It Works

```
User Message → Chatter Server → OpenAI (Embeddings) → Turso (Vector Search)
                    ↓
              GPT-4 Response ← Context from Knowledge Base
                    ↓
              Streaming Response → User
```

### Two Chat Modes

**Public Mode**:
- API key authentication
- Rate limited by IP
- Access to public knowledge
- Perfect for customer support

**Private Mode**:
- JWT authentication
- Rate limited by user
- Access to private knowledge
- Perfect for internal tools

## Common Use Cases

### Customer Support Bot
- Public chat mode
- Knowledge base with FAQs, documentation
- Embedded on website with ChatButton widget
- See: [Requirements](./requirements.md) → [Server Setup](./server.md) → [Client Setup](./client.md)

### Internal Knowledge Assistant
- Private chat mode
- Knowledge base with runbooks, procedures
- Authenticated with Clerk or custom JWT
- See: [Requirements](./requirements.md) → [Server Setup](./server.md) → [Deployment](./deployment.md)

### Product Documentation Chat
- Public chat mode
- Knowledge base with product docs
- Inline Chat widget on documentation site
- See: [Server Setup](./server.md) → [Client Setup](./client.md)

## Resources

### Links
- **[Chatter Repository](https://github.com/diegoaltoworks/chatter)** - Framework source code
- **[Chatter Demo](https://github.com/diegoaltoworks/chatter-demo)** - Complete implementation example
- **[NPM Package](https://www.npmjs.com/package/@diegoaltoworks/chatter)** - Install from npm

### Support
- **[GitHub Discussions](https://github.com/diegoaltoworks/chatter/discussions)** - Ask questions
- **[GitHub Issues](https://github.com/diegoaltoworks/chatter/issues)** - Report bugs

## Contributing

Contributions are welcome! See the [Chatter repository](https://github.com/diegoaltoworks/chatter) for contribution guidelines.

## License

MIT License - see [LICENSE](https://github.com/diegoaltoworks/chatter/blob/main/LICENSE) for details.

---

**Ready to get started?** Begin with [Requirements](./requirements.md) →
