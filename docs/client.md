# Client Setup

This guide covers integrating Chatter chat widgets into your website or application.

## Overview

Chatter provides two ways to integrate chat:

1. **Widgets** (Vanilla JavaScript) - Load from your Chatter server, zero build step
2. **React Components** (NPM) - Install package, full TypeScript support

## Using Widgets (Vanilla JavaScript)

Every Chatter server automatically serves ready-to-use widgets at `/chatter.js` and `/chatter.css` -
on Bun always, and on Node once the optional peer `@hono/node-server` is installed. Without it (or
`features: { headless: true }`), those two routes 404 and the server logs why. See
[Runtime](../README.md#runtime) in the README for the full story.

Perfect for:
- Quick integration on any website
- No build step required
- Works with any framework (or no framework)
- HTML-only sites

### Installation

```html
<!DOCTYPE html>
<html>
<head>
  <!-- Load styles from your Chatter server -->
  <link rel="stylesheet" href="https://your-bot.example.com/chatter.css">
</head>
<body>
  <!-- Your content -->

  <!-- Load widget from your Chatter server -->
  <script src="https://your-bot.example.com/chatter.js"></script>
  <script>
    // Initialize chat widget (see examples below)
  </script>
</body>
</html>
```

### Available Widgets

#### ChatButton (Floating Button)

A floating chat button that opens a modal chat window.

```html
<script>
  new Chatter.ChatButton({
    host: 'your-bot.example.com',
    mode: 'public',
    apiKey: 'your-api-key',
    position: 'bottom-right'
  });
</script>
```

**Options**:
- `host` - Your Chatter server hostname (without https://)
- `mode` - `'public'` or `'private'`
- `apiKey` - API key, required in both modes (get with `npx chatter`)
- `token` - Access token, required when `mode` is `'private'`
- `position` - `'bottom-right'`, `'bottom-left'`, `'top-right'` or `'top-left'`
- `label` - Button text or icon. Default: `'💬'`
- `styles` - Inline style overrides for the button, a `Partial<CSSStyleDeclaration>`
- `chatConfig` - Options forwarded to the popup `Chat` (`title`, `subtitle`,
  `placeholder`, `initialMessages`)

#### Chat (Inline Chat)

An inline chat component that embeds directly in your page.

```html
<div id="chat-container"></div>

<script>
  new Chatter.Chat({
    host: 'your-bot.example.com',
    mode: 'public',
    apiKey: 'your-api-key',
    container: '#chat-container'
  });
</script>
```

**Options**:
- `host` - Your Chatter server hostname
- `mode` - `'public'` or `'private'`
- `apiKey` - API key, required in both modes
- `token` - Access token, required when `mode` is `'private'`
- `container` - CSS selector, or an `HTMLElement`, to render into
- `title` - Chat window title. Default: `'Chat'`
- `subtitle` - Optional line under the title
- `placeholder` - Input placeholder. Default: `'Type your message...'`
- `initialMessages` - Messages to display before the first exchange
- `onClose` - Called when the close button is clicked

#### ChatBot (Headless API Client)

`ChatBot` is the transport the two widgets are built on: it talks to
`/api/{mode}/chat` and renders nothing. Use it to drive your own UI.

```html
<script>
  const bot = new Chatter.ChatBot({
    host: 'your-bot.example.com',
    mode: 'public',
    apiKey: 'your-api-key'
  });

  bot.sendMessage('Hello').then((reply) => console.log(reply));
</script>
```

**Options**:
- `host` - Your Chatter server hostname
- `mode` - `'public'` or `'private'`
- `apiKey` - API key, required in both modes
- `token` - Access token, required when `mode` is `'private'`

**Methods**: `sendMessage(text)`, `sendConversation(messages)`,
`streamMessage(text, callbacks)`, `streamConversation(messages, callbacks)`.

### Public Mode Example

For public-facing chat (customer support, etc.):

```html
<!DOCTYPE html>
<html>
<head>
  <link rel="stylesheet" href="https://bot.example.com/chatter.css">
</head>
<body>
  <h1>Welcome to our site!</h1>

  <script src="https://bot.example.com/chatter.js"></script>
  <script>
    new Chatter.ChatButton({
      host: 'bot.example.com',
      mode: 'public',
      apiKey: 'eyJhbGciOiJIUzI1NiJ9...',
      position: 'bottom-right'
    });
  </script>
</body>
</html>
```

### Private Mode Example

For authenticated users with Clerk:

```html
<!DOCTYPE html>
<html>
<head>
  <link rel="stylesheet" href="https://bot.example.com/chatter.css">
  <!-- Clerk -->
  <script async crossorigin="anonymous" src="https://clerk.example.com/npm/@clerk/clerk-js@latest/dist/clerk.browser.js"></script>
</head>
<body>
  <div id="user-button"></div>
  <div id="chat-container"></div>

  <script src="https://bot.example.com/chatter.js"></script>
  <script>
    window.addEventListener('load', async () => {
      // Initialize Clerk
      const clerk = window.Clerk;
      await clerk.load({
        publishableKey: 'pk_live_...'
      });

      // Mount user button
      clerk.mountUserButton(document.getElementById('user-button'));

      // Initialize chat. Private mode needs BOTH an API key and the
      // signed-in user's token - the key authenticates the caller, the
      // token authenticates the user.
      new Chatter.Chat({
        host: 'bot.example.com',
        mode: 'private',
        apiKey: 'eyJhbGciOiJIUzI1NiJ9...',
        token: await clerk.session.getToken(),
        container: '#chat-container'
      });
    });
  </script>
</body>
</html>
```

## Using React Components

For more control and TypeScript support, install the NPM package.

### Installation

```bash
npm install @diegoaltoworks/chatter
# or
bun add @diegoaltoworks/chatter
```

### Import and Use

```typescript
import { ChatButton } from '@diegoaltoworks/chatter/client';
import '@diegoaltoworks/chatter/client/style.css';

// Initialize
new ChatButton({
  host: 'your-bot.example.com',
  mode: 'public',
  apiKey: 'your-api-key'
});
```

### React Integration

```tsx
import { useEffect } from 'react';
import { ChatButton } from '@diegoaltoworks/chatter/client';
import '@diegoaltoworks/chatter/client/style.css';

export function App() {
  useEffect(() => {
    const chat = new ChatButton({
      host: 'bot.example.com',
      mode: 'public',
      apiKey: import.meta.env.VITE_CHATTER_API_KEY
    });

    return () => chat.destroy?.(); // Cleanup if available
  }, []);

  return (
    <div>
      <h1>My App</h1>
      {/* Chat button will appear automatically */}
    </div>
  );
}
```

### Next.js Integration

```tsx
'use client';

import { useEffect } from 'react';
import { ChatButton } from '@diegoaltoworks/chatter/client';
import '@diegoaltoworks/chatter/client/style.css';

export default function ChatWidget() {
  useEffect(() => {
    new ChatButton({
      host: process.env.NEXT_PUBLIC_CHATTER_HOST!,
      mode: 'public',
      apiKey: process.env.NEXT_PUBLIC_CHATTER_API_KEY!
    });
  }, []);

  return null;
}
```

Then use in your layout:

```tsx
import ChatWidget from '@/components/ChatWidget';

export default function RootLayout({ children }) {
  return (
    <html>
      <body>
        {children}
        <ChatWidget />
      </body>
    </html>
  );
}
```

## Styling

There is no theme object. The widgets ship plain CSS classes, all prefixed
`chatter-ui-`, and you restyle them with your own stylesheet loaded after
`/chatter.css`:

```css
.chatter-ui-chat-button { background: #2563eb; width: 60px; height: 60px; }
.chatter-ui-chat { font-family: system-ui, sans-serif; border-radius: 12px; }
.chatter-ui-chat-header { background: #2563eb; }
```

`ChatButton` additionally takes `styles`, applied inline to the floating
button element. It is a `Partial<CSSStyleDeclaration>`, so the keys are DOM
style properties (camelCase), not CSS property names:

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

Server-side `branding.publicPrimaryColor` / `branding.privatePrimaryColor` are
published on `GET /config` for your own page to read. The built-in widgets do
not consume them: they are a channel for passing your palette to the client,
not a theming engine. See [Server Setup](./server.md).

## Authentication Modes

### Public Mode

Uses API key for authentication:

```javascript
new Chatter.Chat({
  host: 'bot.example.com',
  mode: 'public',
  apiKey: 'eyJhbGciOiJIUzI1NiJ9...',  // Get with: npx chatter
  container: '#chat-container'
});
```

**Characteristics**:
- Rate limited by IP address
- Access to public knowledge base
- No user account required
- Perfect for customer support

### Private Mode

Uses an API key plus a per-user JWT (typically from Clerk). Both are required:
the constructor throws `token is required for private mode` without the token,
and `apiKey is required` without the key.

```javascript
// After Clerk is loaded and user is signed in
new Chatter.Chat({
  host: 'bot.example.com',
  mode: 'private',
  apiKey: 'eyJhbGciOiJIUzI1NiJ9...',
  token: await clerk.session.getToken(),
  container: '#chat-container'
});
```

**Characteristics**:
- Rate limited by user ID
- Access to private knowledge base
- Requires user authentication
- Perfect for internal tools

## API Reference

These are the exported types verbatim; `src/client/src/types.ts` is the source
of truth.

### ChatBotConfig

The base every widget extends.

```typescript
interface ChatBotConfig {
  host: string;              // Chatter server host, protocol added automatically
  mode: 'public' | 'private';
  apiKey: string;            // Required in both modes
  token?: string;            // Required when mode is 'private'
}
```

### ChatConfig

```typescript
interface ChatConfig extends ChatBotConfig {
  container: HTMLElement | string;   // CSS selector or element
  placeholder?: string;
  initialMessages?: ChatMessage[];
  title?: string;
  subtitle?: string;
  onClose?: () => void;
}
```

### ChatButtonConfig

```typescript
interface ChatButtonConfig extends ChatBotConfig {
  position?: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
  label?: string;
  styles?: Partial<CSSStyleDeclaration>;
  chatConfig?: Partial<Omit<ChatConfig, 'host' | 'mode' | 'apiKey' | 'token'>>;
}
```

## Demo Implementations

See live examples at your Chatter server's demo page:

```
https://your-bot.example.com/demo/
```

Or check the [chatter-demo](https://github.com/diegoaltoworks/chatter-demo) repository for complete implementation examples.

## Troubleshooting

### Widget not loading

**Check**:
1. Chatter server is running
2. Server URL is correct (no typos)
3. CORS is enabled on server
4. Check browser console for errors

### Authentication errors

**Public mode**:
- Verify API key is valid (not expired)
- Check API key is passed correctly

**Private mode**:
- Verify Clerk is loaded
- User is signed in
- JWT configuration matches server

### Styling issues

**Check**:
1. `/chatter.css` is loaded before widgets
2. No CSS conflicts with existing styles
3. Your overrides target the `chatter-ui-` classes and load after `/chatter.css`

### Connection refused

**Check**:
1. Server is accessible from browser
2. HTTPS is configured in production
3. Firewall allows traffic on server port

For more help, see [FAQs](./faqs.md).

## Next Steps

- [Server Setup](./server.md) - Configure your Chatter server
- [Deployment](./deployment.md) - Deploy to production
- [FAQs](./faqs.md) - Common questions and troubleshooting
