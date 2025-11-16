# Client Setup

This guide covers integrating Chatter chat widgets into your website or application.

## Overview

Chatter provides two ways to integrate chat:

1. **Widgets** (Vanilla JavaScript) - Load from your Chatter server, zero build step
2. **React Components** (NPM) - Install package, full TypeScript support

## Using Widgets (Vanilla JavaScript)

Every Chatter server automatically serves ready-to-use widgets at `/chatter.js` and `/chatter.css`.

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
    position: 'bottom-right'  // or 'bottom-left'
  });
</script>
```

**Options**:
- `host` - Your Chatter server hostname (without https://)
- `mode` - `'public'` or `'private'`
- `apiKey` - API key for public mode (get with `npx chatter create-apikey`)
- `position` - Button position: `'bottom-right'` or `'bottom-left'`
- `theme` - Optional theme overrides (see Theming section)

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
- `apiKey` - API key for public mode
- `container` - CSS selector for container element
- `theme` - Optional theme overrides

#### ChatBot (Full-Page Chat)

A full-page chat interface that takes over the entire viewport.

```html
<script>
  new Chatter.ChatBot({
    host: 'your-bot.example.com',
    mode: 'public',
    apiKey: 'your-api-key'
  });
</script>
```

**Options**:
- `host` - Your Chatter server hostname
- `mode` - `'public'` or `'private'`
- `apiKey` - API key for public mode
- `theme` - Optional theme overrides

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

      // Initialize chat
      new Chatter.Chat({
        host: 'bot.example.com',
        mode: 'private',
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

## Theming

Customize the appearance with theme options:

```javascript
new Chatter.ChatButton({
  host: 'bot.example.com',
  mode: 'public',
  apiKey: '...',
  theme: {
    primaryColor: '#2563eb',
    fontFamily: 'system-ui, sans-serif',
    borderRadius: '12px'
  }
});
```

**Available theme options**:
- `primaryColor` - Main accent color
- `fontFamily` - Font family
- `borderRadius` - Border radius for chat elements
- `buttonSize` - Size of floating button (e.g., `'60px'`)

## Authentication Modes

### Public Mode

Uses API key for authentication:

```javascript
new Chatter.Chat({
  host: 'bot.example.com',
  mode: 'public',
  apiKey: 'eyJhbGciOiJIUzI1NiJ9...'  // Get with: npx chatter create-apikey
});
```

**Characteristics**:
- Rate limited by IP address
- Access to public knowledge base
- No user account required
- Perfect for customer support

### Private Mode

Uses JWT authentication (typically via Clerk):

```javascript
// After Clerk is loaded and user is signed in
new Chatter.Chat({
  host: 'bot.example.com',
  mode: 'private'
  // No API key needed - uses session token from Clerk
});
```

**Characteristics**:
- Rate limited by user ID
- Access to private knowledge base
- Requires user authentication
- Perfect for internal tools

## API Reference

### ChatButton

```typescript
interface ChatButtonOptions {
  host: string;              // Chatter server hostname
  mode: 'public' | 'private';
  apiKey?: string;           // Required for public mode
  position?: 'bottom-right' | 'bottom-left';
  theme?: ThemeOptions;
}
```

### Chat

```typescript
interface ChatOptions {
  host: string;
  mode: 'public' | 'private';
  apiKey?: string;           // Required for public mode
  container: string;         // CSS selector
  theme?: ThemeOptions;
}
```

### ChatBot

```typescript
interface ChatBotOptions {
  host: string;
  mode: 'public' | 'private';
  apiKey?: string;           // Required for public mode
  theme?: ThemeOptions;
}
```

### ThemeOptions

```typescript
interface ThemeOptions {
  primaryColor?: string;
  fontFamily?: string;
  borderRadius?: string;
  buttonSize?: string;
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
3. Theme options are valid

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
