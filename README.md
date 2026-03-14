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

## Documentation

Complete guides for setup, deployment, and integration:

- **[Requirements](./docs/requirements.md)** - OpenAI, Turso, Clerk setup and pricing
- **[Server Setup](./docs/server.md)** - Configuration, knowledge base, prompts, API keys
- **[Client Integration](./docs/client.md)** - Widgets, React components, theming
- **[Deployment](./docs/deployment.md)** - Google Cloud Run, Fly.io, Railway, VPS
- **[Testing Guide](./docs/testing/README.md)** - Comprehensive testing documentation (254 tests, 98% coverage)
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

## License

MIT © [Diego Alto](https://github.com/diegoaltoworks)
