# DiegoBot Client Library

A simple JavaScript client for consuming the DiegoBot API from remote servers.

## Features

- Support for both `public` and `private` scopes
- Single message and multi-turn conversation support
- Streaming and non-streaming responses
- Works in Node.js and browser environments
- Simple, clean API

## Installation

Simply copy `chatbot.js` to your project and require/import it:

```javascript
// Node.js
const DiebotClient = require('./chatbot.js');

// Browser
<script src="chatbot.js"></script>
```

## Configuration

### Public Mode

For public API access:

```javascript
const client = new ChatBot({
  host: 'your-api-host.com',
  mode: 'public',
  apiKey: 'your-public-api-key'
});
```

### Private Mode

For private API access (requires access token):

```javascript
const client = new ChatBot({
  host: 'your-api-host.com',
  mode: 'private',
  apiKey: 'your-api-key',
  token: 'your-access-token'
});
```

## Usage

### Single Message

Send a single message and get a response:

```javascript
const reply = await client.sendMessage('Hello, how can you help me?');
console.log(reply);
```

### Conversation History

Send a conversation with history:

```javascript
const messages = [
  { role: 'user', content: 'What is your name?' },
  { role: 'assistant', content: 'I am DiegoBot.' },
  { role: 'user', content: 'What can you do?' }
];

const reply = await client.sendConversation(messages);
console.log(reply);
```

### Streaming Response

Stream a single message response:

```javascript
await client.streamMessage(
  'Tell me a story',
  (delta) => {
    // Called for each chunk
    process.stdout.write(delta);
  },
  () => {
    // Called when stream ends
    console.log('\n[Done]');
  },
  (error) => {
    // Called on error
    console.error('Error:', error.message);
  }
);
```

### Streaming Conversation

Stream a conversation response:

```javascript
const messages = [
  { role: 'user', content: 'Tell me about yourself' }
];

await client.streamConversation(
  messages,
  (delta) => process.stdout.write(delta),
  () => console.log('\n[Done]'),
  (error) => console.error('Error:', error.message)
);
```

## API Reference

### Constructor

```javascript
new ChatBot(config)
```

**config:**
- `host` (string, required): Host of the DiegoBot API (e.g., 'api.example.com' - https:// will be added automatically)
- `mode` (string, required): Either `'public'` or `'private'`
- `apiKey` (string, required): API key for authentication
- `token` (string, optional): Access token (required only for `'private'` mode)

### Methods

#### `sendMessage(message)`

Send a single message to the chatbot.

**Parameters:**
- `message` (string): The message to send

**Returns:** Promise<string> - The bot's reply

#### `sendConversation(messages)`

Send a conversation history.

**Parameters:**
- `messages` (Array): Array of message objects with `role` ('user' | 'assistant') and `content` (string)

**Returns:** Promise<string> - The bot's reply

#### `streamMessage(message, onChunk, onEnd, onError)`

Stream a single message response.

**Parameters:**
- `message` (string): The message to send
- `onChunk` (Function): Callback for each chunk - `(delta: string) => void`
- `onEnd` (Function, optional): Callback when stream ends - `() => void`
- `onError` (Function, optional): Callback for errors - `(error: Error) => void`

#### `streamConversation(messages, onChunk, onEnd, onError)`

Stream a conversation response.

**Parameters:**
- `messages` (Array): Array of message objects
- `onChunk` (Function): Callback for each chunk - `(delta: string) => void`
- `onEnd` (Function, optional): Callback when stream ends - `() => void`
- `onError` (Function, optional): Callback for errors - `(error: Error) => void`

## Error Handling

All methods throw errors for:
- Missing or invalid configuration
- API errors (authentication, rate limiting, etc.)
- Network errors

Always wrap calls in try-catch blocks:

```javascript
try {
  const reply = await client.sendMessage('Hello');
  console.log(reply);
} catch (error) {
  console.error('Error:', error.message);
}
```

## Examples

See `example.js` for complete working examples.
