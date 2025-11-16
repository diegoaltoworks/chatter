# @diegoaltoworks/chatter

Isomorphic TypeScript chatbot client for DiegoBot API. Works seamlessly in both Node.js and browser environments.

## Features

- 🚀 **Isomorphic** - Works in Node.js and browsers
- 📦 **Multiple formats** - ESM, CJS, and UMD bundles
- 🎨 **UI Components** - Ready-to-use Chat and ChatButton components
- 💪 **TypeScript** - Full type safety
- 🎯 **Zero dependencies** - Lean and fast
- 🔄 **Streaming support** - Real-time responses
- 🎭 **Two modes** - Public and Private authentication

## Installation

### NPM Package

```bash
npm install @diegoaltoworks/chatter
```

### CDN (Browser)

```html
<!-- Include the script -->
<script src="https://bot.diegoalto.app/chatter.js"></script>

<!-- Include the styles -->
<link rel="stylesheet" href="https://bot.diegoalto.app/chatter.css">
```

## Getting an API Key

If you're using a Chatter server, you can generate API keys using the CLI:

```bash
# On the server side
npx chatter create-apikey --name "my-website" --expires-in 365d
```

This will output a JWT token to use as your `apiKey` in the client configuration.

For more information, see the [Chatter server documentation](https://github.com/diegoaltoworks/chatter).

## Usage

### 1. API Client Only

#### Node.js / ES Modules

```typescript
import { ChatBot } from '@diegoaltoworks/chatter';

const bot = new ChatBot({
  host: 'bot.diegoalto.app',
  mode: 'public',
  apiKey: 'your-api-key'
});

// Send a message
const reply = await bot.sendMessage('Hello!');
console.log(reply);

// Stream a response
await bot.streamMessage('Tell me a story', {
  onChunk: (delta) => process.stdout.write(delta),
  onEnd: () => console.log('\nDone!'),
  onError: (err) => console.error(err)
});
```

#### Browser (Script Tag)

```html
<script src="https://bot.diegoalto.app/chatter.js"></script>
<script>
  const bot = new Chatter.ChatBot({
    host: 'bot.diegoalto.app',
    mode: 'public',
    apiKey: 'your-api-key'
  });

  bot.sendMessage('Hello!').then(reply => {
    console.log(reply);
  });
</script>
```

### 2. Chat Window Component

```typescript
import { Chat } from '@diegoaltoworks/chatter';
import '@diegoaltoworks/chatter/style.css';

const chat = new Chat({
  host: 'bot.diegoalto.app',
  mode: 'public',
  apiKey: 'your-api-key',
  container: '#chat-container',
  title: 'DiegoBot',
  subtitle: 'Ask me anything!',
  placeholder: 'Type your message...'
});
```

#### Browser (Script Tag)

```html
<link rel="stylesheet" href="https://bot.diegoalto.app/chatter.css">
<div id="chat"></div>

<script src="https://bot.diegoalto.app/chatter.js"></script>
<script>
  new Chatter.Chat({
    host: 'bot.diegoalto.app',
    mode: 'public',
    apiKey: 'your-api-key',
    container: '#chat',
    title: 'DiegoBot'
  });
</script>
```

### 3. Floating Chat Button

```typescript
import { ChatButton } from '@diegoaltoworks/chatter';
import '@diegoaltoworks/chatter/style.css';

const chatButton = new ChatButton({
  host: 'bot.diegoalto.app',
  mode: 'public',
  apiKey: 'your-api-key',
  position: 'bottom-right',
  label: '💬',
  chatConfig: {
    title: 'Support Chat',
    subtitle: 'We typically reply in a few minutes'
  }
});
```

#### Browser (Script Tag)

```html
<link rel="stylesheet" href="https://bot.diegoalto.app/chatter.css">

<script src="https://bot.diegoalto.app/chatter.js"></script>
<script>
  new Chatter.ChatButton({
    host: 'bot.diegoalto.app',
    mode: 'public',
    apiKey: 'your-api-key',
    position: 'bottom-right'
  });
</script>
```

## API Reference

### ChatBot

#### Constructor

```typescript
new ChatBot(config: ChatBotConfig)
```

**Config:**
- `host` (string, required): API host (e.g., 'bot.diegoalto.app')
- `mode` ('public' | 'private', required): Authentication mode
- `apiKey` (string, required): API key
- `token` (string, optional): Access token (required for private mode)

#### Methods

**`sendMessage(message: string): Promise<string>`**
Send a single message and get the full response.

**`sendConversation(messages: ChatMessage[]): Promise<string>`**
Send a conversation history and get the full response.

**`streamMessage(message: string, callbacks: StreamCallbacks): Promise<void>`**
Stream a single message response.

**`streamConversation(messages: ChatMessage[], callbacks: StreamCallbacks): Promise<void>`**
Stream a conversation response.

### Chat

#### Constructor

```typescript
new Chat(config: ChatConfig)
```

**Config:** (extends ChatBotConfig)
- All ChatBotConfig options
- `container` (HTMLElement | string, required): Container element or selector
- `title` (string, optional): Chat window title
- `subtitle` (string, optional): Chat window subtitle
- `placeholder` (string, optional): Input placeholder text
- `initialMessages` (ChatMessage[], optional): Initial messages to display

#### Methods

**`clear(): void`**
Clear all messages.

**`getMessages(): ChatMessage[]`**
Get current conversation.

**`destroy(): void`**
Destroy the chat instance.

### ChatButton

#### Constructor

```typescript
new ChatButton(config: ChatButtonConfig)
```

**Config:** (extends ChatBotConfig)
- All ChatBotConfig options
- `position` ('bottom-right' | 'bottom-left' | 'top-right' | 'top-left', optional): Button position
- `label` (string, optional): Button text/emoji
- `styles` (Partial<CSSStyleDeclaration>, optional): Custom button styles
- `chatConfig` (Partial<ChatConfig>, optional): Chat window configuration

#### Methods

**`open(): void`**
Open the chat window.

**`close(): void`**
Close the chat window.

**`isOpened(): boolean`**
Check if chat is open.

**`destroy(): void`**
Destroy the button and cleanup.

## TypeScript Support

Full TypeScript support with exported types:

```typescript
import type {
  ChatBotConfig,
  ChatConfig,
  ChatButtonConfig,
  ChatMessage,
  ChatMode,
  StreamCallbacks
} from '@diegoaltoworks/chatter';
```

## Private Mode

For private/internal use with JWT authentication:

```typescript
const bot = new ChatBot({
  host: 'bot.diegoalto.app',
  mode: 'private',
  apiKey: 'your-api-key',
  token: 'your-jwt-token' // Required for private mode
});
```

## Examples

See the `examples/` directory for complete working examples:
- `examples/browser.html` - Browser usage with script tag
- `examples/react.tsx` - React integration
- `examples/node.ts` - Node.js usage

## Building from Source

```bash
# Install dependencies
npm install

# Build all formats
npm run build

# Type check
npm run typecheck

# Development mode (watch)
npm run dev
```

## License

MIT
