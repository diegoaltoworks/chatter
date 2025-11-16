# Chatter

<div align="center">

**Embeddable AI chatbot framework with RAG, authentication, and customizable widgets**

[![NPM Version](https://img.shields.io/npm/v/@diegoaltoworks/chatter)](https://www.npmjs.com/package/@diegoaltoworks/chatter)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![CI](https://github.com/diegoaltoworks/chatter/actions/workflows/ci.yml/badge.svg)](https://github.com/diegoaltoworks/chatter/actions/workflows/ci.yml)
[![Demo](https://img.shields.io/badge/demo-chatter--demo-blue)](https://github.com/diegoaltoworks/chatter-demo)

[Features](#features) • [Quick Start](#quick-start) • [Demo](#demo) • [Client Setup](#client-setup)

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

## Requirements

| Requirement | Details |
|-------------|---------|
| **OpenAI** | LLM completions and text embeddings for RAG<br><br>**Setup:**<br>1. Sign up: https://platform.openai.com/signup<br>2. Get API key: https://platform.openai.com/api-keys<br>3. Pricing: https://openai.com/pricing<br><br>**Environment Variables:**<br>`OPENAI_API_KEY` |
| **Turso** | Vector database for embeddings storage<br><br>**Setup:**<br>1. Sign up: https://turso.tech<br>2. Install Turso CLI: `curl -sSfL https://get.tur.so/install.sh \| bash`<br>3. Create database: `turso db create <db-name>`<br>4. Get URL: `turso db show <db-name> --url`<br>5. Create token: `turso db tokens create <db-name>`<br>6. Pricing: Free tier available<br><br>**Environment Variables:**<br>`TURSO_URL`, `TURSO_AUTH_TOKEN` |
| **Clerk**<br>(Optional) | User authentication for private/staff chat<br><br>**Setup:**<br>1. Sign up: https://clerk.com<br>2. Get credentials: Dashboard → API Keys<br>3. Required for: Private chat mode only<br>4. Pricing: Free tier available<br><br>**Environment Variables:**<br>`CLERK_PUBLISHABLE_KEY`, `CLERK_FRONTEND_URL` |

## Quick Start

### Installation

```bash
npm install @diegoaltoworks/chatter
# or
bun add @diegoaltoworks/chatter
```

### Basic Server Setup

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

### API Key Management

Chatter includes a built-in API key management system using JWT tokens. Set a secret in your environment:

```bash
export CHATTER_SECRET=your-secret-key-here
```

Then create API keys using the included CLI tool:

```bash
# Create a key that expires in 1 year
npx chatter create-apikey --name "mobile-app" --expires-in 365d

# Create a short-lived test key
npx chatter create-apikey --name "test" --expires-in 1h
```

The CLI will output a JWT token that clients can use to authenticate:

```
✅ API Key generated successfully!

   Name:       mobile-app
   ID:         550e8400-e29b-41d4-a716-446655440000
   Expires:    2025-11-16T12:00:00.000Z (365d)

   API Key:
   eyJhbGciOiJIUzI1NiJ9.eyJuYW1lIjoibW9iaWxlLWFwcCIsInR5cGUiOiJhcGlfa2V5Ii...
```

**Programmatic Usage:**

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

## Client Setup

Once your server is running, you can embed the chat on your website using either pre-built widgets or React components.

### Using Widgets (Vanilla JavaScript)

Every Chatter server automatically serves ready-to-use widgets at `/chatter.js` and `/chatter.css`. Perfect for quick integration on any website:

```html
<!DOCTYPE html>
<html>
<head>
  <!-- Load styles from your Chatter server -->
  <link rel="stylesheet" href="https://your-bot.example.com/chatter.css">
</head>
<body>
  <!-- Load widget from your Chatter server -->
  <script src="https://your-bot.example.com/chatter.js"></script>
  <script>
    // Create a floating chat button
    new Chatter.ChatButton({
      host: 'your-bot.example.com',
      mode: 'public',
      apiKey: 'your-api-key',
      position: 'bottom-right'
    });
  </script>
</body>
</html>
```

Available widgets: `ChatButton` (floating button), `Chat` (inline chat), `ChatBot` (full-page chat).

### Using React Components

For more customization and control, install the npm package and use React components:

```bash
npm install @diegoaltoworks/chatter
```

```typescript
import { ChatButton } from '@diegoaltoworks/chatter/client';
import '@diegoaltoworks/chatter/client/style.css';

new ChatButton({
  host: 'your-bot.example.com',
  mode: 'public',
  apiKey: 'your-api-key'
});
```

React components give you full control over styling, behavior, and integration with your app's state management.

## License

MIT © [Diego Alto](https://github.com/diegoaltoworks)
