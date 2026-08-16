# Deep Chat + Chatter

Minimal example of using the [Deep Chat](https://deepchat.dev) web component as
the UI for a Chatter server, via the OpenAI-compatible endpoint.

No build step - Deep Chat is loaded from a CDN and works in any framework (or
none, as here).

## Run it

1. Start a Chatter server (see the repo README). The OpenAI-compatible endpoint
   is enabled by default at `POST /v1/chat/completions`. You can run the server
   fully headless (no built-in widget) with:

   ```ts
   features: { headless: true }
   ```

2. Create an API key:

   ```bash
   bunx chatter
   ```

3. Edit `index.html` and set `CHATTER_URL` and `CHATTER_API_KEY`.

4. Serve this directory (browsers block `fetch` from `file://` pages):

   ```bash
   bunx serve examples/deep-chat
   ```

## How it works

Deep Chat's `connect.handler` converts the widget's message format to OpenAI
chat-completions JSON, POSTs it to Chatter, and streams the SSE
`chat.completion.chunk` deltas back into the widget via `signals.onResponse`.

For the private (JWT-authenticated) pipeline, point the URL at
`/api/private/v1/chat/completions` and send your user's JWT as the Bearer token.
