# @fyne/chatbot - Package Summary

## ✅ Complete! Isomorphic TypeScript Chatbot Package

The package is now fully built and ready to use. It works in both Node.js and browser environments.

## 📦 Package Structure

```
src/client/
├── package.json              # NPM package configuration
├── tsconfig.json             # TypeScript configuration
├── .gitignore
├── README.md                 # Full documentation
│
├── src/                      # TypeScript source files
│   ├── index.ts             # Main entry point (ESM/CJS)
│   ├── browser.ts           # Browser bundle entry point
│   ├── types.ts             # Shared TypeScript types
│   ├── ChatBot.ts           # API client class
│   ├── Chat.ts              # Chat UI component
│   ├── ChatButton.ts        # Floating button component
│   └── styles.css           # Component styles
│
├── dist/                     # Built outputs
│   ├── chatbot.min.js       # Browser bundle (UMD, 8.2KB)
│   ├── chatbot.css          # Styles (4.6KB)
│   ├── index.mjs            # ES Module (12KB)
│   ├── index.js             # CommonJS (13KB)
│   └── *.d.ts               # TypeScript definitions
│
└── examples/                 # Usage examples
    ├── browser.html         # Full browser examples
    ├── simple.html          # Minimal browser example
    └── node.ts              # Node.js example
```

## 🚀 Usage Methods

### 1. NPM Package (Node.js/Bundlers)

```bash
npm install @fyne/chatbot
```

```typescript
import { ChatBot, Chat, ChatButton } from '@fyne/chatbot';
import '@fyne/chatbot/style.css';
```

### 2. CDN (Browser Script Tag)

```html
<link rel="stylesheet" href="https://bot.diegoalto.app/chatbot.css">
<script src="https://bot.diegoalto.app/chatbot.min.js"></script>

<script>
  // All exports available under global Chatter object
  const bot = new Chatter.ChatBot({ ... });
  const chat = new Chatter.Chat({ ... });
  const button = new Chatter.ChatButton({ ... });
</script>
```

## 📚 Available Exports

### ChatBot Class
API client for programmatic access:
- `sendMessage(message)` - Send single message
- `sendConversation(messages)` - Send conversation history
- `streamMessage(message, callbacks)` - Stream response
- `streamConversation(messages, callbacks)` - Stream conversation

### Chat Class
Full chat window component:
- Renders complete chat UI
- Message history
- Text input with auto-resize
- Streaming responses
- Methods: `clear()`, `getMessages()`, `destroy()`

### ChatButton Class
Floating chat button with popup:
- Customizable position (4 corners)
- Auto-popup chat window
- Click outside to close
- Methods: `open()`, `close()`, `isOpened()`, `destroy()`

## 🎯 Quick Start Examples

### Browser (One-liner)
```html
<link rel="stylesheet" href="https://bot.diegoalto.app/chatbot.css">
<script src="https://bot.diegoalto.app/chatbot.min.js"></script>
<script>
  new Chatter.ChatButton({
    host: 'bot.diegoalto.app',
    mode: 'public',
    apiKey: 'your-api-key'
  });
</script>
```

### React/Next.js
```tsx
'use client';
import { useEffect } from 'react';
import { ChatButton } from '@fyne/chatbot';
import '@fyne/chatbot/style.css';

export default function ChatWidget() {
  useEffect(() => {
    const button = new ChatButton({
      host: 'bot.diegoalto.app',
      mode: 'public',
      apiKey: process.env.NEXT_PUBLIC_CHATBOT_KEY!
    });
    return () => button.destroy();
  }, []);

  return null;
}
```

### Node.js API Client
```typescript
import { ChatBot } from '@fyne/chatbot';

const bot = new ChatBot({
  host: 'bot.diegoalto.app',
  mode: 'public',
  apiKey: process.env.CHATBOT_KEY
});

const reply = await bot.sendMessage('Hello!');
```

## 🔧 Build Commands

```bash
# Build all formats
bun run build

# Development watch mode
bun run dev

# Type check only
bun run typecheck

# Clean dist folder
bun run clean
```

## 📤 Distribution

### For CDN Usage
Serve these files from your API at `bot.diegoalto.app`:
- `/chatbot.min.js` → `dist/chatbot.min.js` (8.2KB)
- `/chatbot.css` → `dist/chatbot.css` (4.6KB)

### For NPM Publishing
```bash
cd src/client
npm publish
```

The package is configured with proper `exports` field for modern Node.js resolution.

## 🎨 Customization

### Styling
The CSS uses custom properties and can be overridden:
```css
.fyne-chat-header {
  background: linear-gradient(135deg, #your-color 0%, #your-color-2 100%);
}
```

### Components
All components accept configuration objects and are fully typed with TypeScript.

## ✨ Features

✅ Isomorphic (Node.js + Browser)
✅ TypeScript with full type definitions
✅ Multiple output formats (ESM, CJS, UMD)
✅ Zero runtime dependencies
✅ Streaming support
✅ Two auth modes (public/private)
✅ UI components with vanilla JS (no framework needed)
✅ Responsive design
✅ Accessible (ARIA labels, keyboard support)
✅ Clean, modern UI
✅ Small bundle size (~8KB minified)

## 🔒 Authentication Modes

**Public Mode**: Uses `x-api-key` header
```javascript
{ host: '...', mode: 'public', apiKey: 'key' }
```

**Private Mode**: Uses JWT Bearer token
```javascript
{ host: '...', mode: 'private', apiKey: 'key', token: 'jwt-token' }
```

## 📝 Next Steps

1. **Serve from API**: Add routes to serve `chatbot.min.js` and `chatbot.css`
2. **Publish to NPM**: Run `npm publish` (after updating package name if needed)
3. **Test**: Open `examples/browser.html` in a browser
4. **Document**: Update your main project README with integration instructions

---

**Package Version**: 1.0.0
**Build Date**: 2025-10-20
**Status**: ✅ Ready for Production
