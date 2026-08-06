# assistant-ui + Chatter

Minimal React app using [assistant-ui](https://www.assistant-ui.com) as the UI
for a Chatter server, via the OpenAI-compatible endpoint.

A custom `ChatModelAdapter` (see `src/App.tsx`) streams from
`POST /v1/chat/completions`; assistant-ui's primitives render the thread. The
example uses unstyled primitives with a small CSS file so it has no extra
dependencies — for a production look, use assistant-ui's styled `Thread`
component (shadcn setup) with the same adapter.

## Run it

1. Start a Chatter server (see the repo README). The OpenAI-compatible endpoint
   is enabled by default. You can run the server fully headless (no built-in
   widget) with:

   ```ts
   features: { headless: true }
   ```

2. Create an API key:

   ```bash
   bunx chatter create-apikey
   ```

3. Install and run:

   ```bash
   cd examples/assistant-ui
   bun install
   VITE_CHATTER_URL=http://localhost:8181 VITE_CHATTER_API_KEY=<your-key> bun run dev
   ```

For the private (JWT-authenticated) pipeline, point the adapter at
`/api/private/v1/chat/completions` and send your user's JWT as the Bearer token.
