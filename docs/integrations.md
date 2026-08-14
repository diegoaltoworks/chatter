# UI Integrations & OpenAI-Compatible API

Chatter's value lives on the server: RAG retrieval, guardrails, auth, and rate
limiting. The built-in widget is optional — any chat UI that speaks the OpenAI
chat-completions wire format can be the front end.

## OpenAI-compatible endpoints

Enabled by default (disable with `features.enableOpenAICompat: false`):

| Endpoint | Pipeline | Auth |
| --- | --- | --- |
| `POST /v1/chat/completions` | public (public + base knowledge) | Chatter API key via `Authorization: Bearer <key>` or `x-api-key` |
| `POST /api/private/v1/chat/completions` | private (private + base knowledge) | JWT via `Authorization: Bearer <token>` (JWKS or PEM, same as `/api/private/chat`) |

Both accept standard OpenAI request bodies and support `stream: true`
(Server-Sent Events with `chat.completion.chunk` objects, terminated by
`data: [DONE]`) as well as non-streaming JSON responses.

Notes:

- **The server picks the model.** A client-supplied `model` field is accepted
  for wire compatibility but ignored; the upstream model is always
  `config.openai.model` (default `gpt-4o`). Clients must not control your
  spend.
- **The server owns the system prompt.** Incoming `system`/`tool` messages are
  dropped; guardrails, persona, and retrieved context are assembled
  server-side.
- The public endpoint requires a real JWT API key (create one with
  `bunx chatter create-apikey`). Widget session keys and demo keys are not
  valid here.

### curl

```bash
curl -N http://localhost:8181/v1/chat/completions \
  -H "Authorization: Bearer $CHATTER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"stream": true, "messages": [{"role": "user", "content": "Hello!"}]}'
```

### OpenAI SDK

Any OpenAI SDK works by pointing `baseURL` at your server:

```ts
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "https://your-chatter-server.com/v1",
  apiKey: process.env.CHATTER_API_KEY,
});

const res = await client.chat.completions.create({
  model: "chatter", // ignored — the server chooses the model
  messages: [{ role: "user", content: "Hello!" }],
});
```

For the private pipeline, use `baseURL: ".../api/private/v1"` and pass the
user's JWT as the `apiKey`.

## Headless mode

To run Chatter as a pure API (no built-in widget assets, no demo pages):

```ts
const app = await createServer({
  // ...
  features: { headless: true },
});
```

`/healthz`, `/config`, the chat APIs, and the OpenAI-compatible endpoints stay
available; `chatter.js`, `chatter.css`, and all static/demo pages are not
served.

## Programmatic use (no HTTP at all)

The RAG pipeline is exported directly, fully decoupled from any UI or
transport:

```ts
import { prepareChat, completeOnce, completeStream } from "@diegoaltoworks/chatter";

const { system, messages } = await prepareChat({
  store,           // VectorStore
  prompts,         // PromptLoader
  mode: "public",  // or "private"
  messages: [{ role: "user", content: "Hello!" }],
});

const { content } = await completeOnce({ client, system, messages });
```

This is the same code path the HTTP routes use, so behaviour (retrieval depth,
personas, guardrails) is identical.

### Shaping the prompt per caller

`prepareChat` assembles the system prompt in layers — base rules, persona,
channel hint, retrieved context — and two optional parameters let a caller
adjust the middle layers without rebuilding the sandwich itself:

```ts
const { system, messages } = await prepareChat({
  store,
  prompts,
  mode: "public",
  messages: [{ role: "user", content: "Hello!" }],
  personaLayer: resolvedPersona,       // replaces the mode's persona
  channelHint: "Channel: SMS. Keep replies short.",
});
```

`personaLayer` replaces the persona the `PromptLoader` would supply for the
mode; a blank or omitted value keeps the configured persona. `channelHint` is
inserted as its own section after the persona and before the retrieved
context, and is omitted entirely when blank. With neither set the prompt is
unchanged, so existing callers need no updates.

## Third-party chat UIs

Two runnable sample apps live in `examples/`:

- **[`examples/deep-chat`](../examples/deep-chat/)** — [Deep Chat](https://deepchat.dev)
  web component (framework-agnostic, no build step). A `connect.handler`
  streams from `/v1/chat/completions`.
- **[`examples/assistant-ui`](../examples/assistant-ui/)** — [assistant-ui](https://www.assistant-ui.com)
  React app (Vite). A custom `ChatModelAdapter` streams from the same
  endpoint.

Both use only the standard endpoint — no Chatter-specific client code — so the
same pattern works for any other OpenAI-compatible UI or SDK.
