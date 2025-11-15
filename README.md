# Chatter

<div align="center">

**Embeddable AI chatbot framework with RAG, authentication, and customizable widgets**

[![NPM Version](https://img.shields.io/npm/v/@diegoaltoworks/chatter)](https://www.npmjs.com/package/@diegoaltoworks/chatter)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![CI](https://github.com/diegoaltoworks/chatter/actions/workflows/ci.yml/badge.svg)](https://github.com/diegoaltoworks/chatter/actions/workflows/ci.yml)

[Features](#features) • [Quick Start](#quick-start) • [Documentation](#documentation) • [Examples](#examples) • [Contributing](#contributing)

</div>

## Features

- 🤖 **RAG-Powered**: Retrieval-Augmented Generation using OpenAI embeddings and Turso vector database
- 🎨 **Customizable Widgets**: Pre-built chat components (ChatBot, Chat, ChatButton) with full styling control
- 🔐 **Authentication Ready**: Built-in support for JWT, Clerk, and custom auth providers
- 📱 **Mobile Optimized**: Responsive design with iOS/Android-specific fixes
- ⚡ **High Performance**: Built on Hono with streaming support
- 🛡️ **Security First**: Rate limiting, CORS, referrer checking, and input guardrails
- 📦 **Framework Agnostic**: Works with any JavaScript framework or vanilla JS
- 🎯 **TypeScript**: Fully typed for excellent developer experience

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
  knowledgeDir: './knowledge',
  promptsDir: './prompts'
});

// Start server (Bun example)
Bun.serve({
  port: 8181,
  fetch: app.fetch
});
```

### Embedding the Chat Widget

```html
<!DOCTYPE html>
<html>
<head>
  <link rel="stylesheet" href="https://unpkg.com/@diegoaltoworks/chatter/dist/client/chatbot.css">
</head>
<body>
  <script src="https://unpkg.com/@diegoaltoworks/chatter/dist/client/chatbot.min.js"></script>
  <script>
    const bot = new Chatter.ChatBot({
      apiUrl: 'https://your-api.example.com',
      apiKey: 'your-api-key',
      mode: 'public'
    });
  </script>
</body>
</html>
```

## License

MIT © [Diego Alto](https://github.com/diegoaltoworks)
