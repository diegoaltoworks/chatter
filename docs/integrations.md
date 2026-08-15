# UI Integrations & OpenAI-Compatible API

Chatter's value lives on the server: RAG retrieval, guardrails, auth, and rate
limiting. The built-in widget is optional — any chat UI that speaks the OpenAI
chat-completions wire format can be the front end.

**The server owns the system prompt on every chat surface.** Whatever a client
sends is normalized before it reaches the pipeline: only `user` and `assistant`
turns survive (`system`, `developer` and `tool` messages are dropped), and
content is reduced to text — a plain string, or the text parts of an
OpenAI-style content-part array. This holds for the widget routes
(`/api/public/chat`, `/api/private/chat`, `/api/demo/chat`) and the
OpenAI-compatible routes alike. Custom routes can apply the same rule with the
exported `normalizeChatBody` / `normalizeMessages` helpers.

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

### Scoping retrieval per caller (`bucketsFor`)

Knowledge is ingested into named buckets, and a chat turn retrieves from `base`
plus the bucket matching its mode. Role-gated deployments need finer control:
an entitlement is only knowable per request. `bucketsFor` is that seam.

```ts
const server = await createServer({
  // ...
  bucketsFor: async ({ mode, sender }) => {
    if (!sender) return undefined;                 // keep the mode defaults
    const roles = await lookupRoles(sender);
    return roles.includes("staff") ? ["base", "private"] : ["base", "public"];
  },
});
```

The hook is consulted by the widget chat routes, the OpenAI-compatible
endpoints, the MCP chat tools and the demo route. It receives the pipeline
`mode` plus, where the surface knows one, a `sender` identity — the private
routes supply the verified JWT subject; the API-key, MCP and demo surfaces have
no per-user identity, so they leave it unset. Return `undefined` to leave the
mode defaults in place, or a list of buckets to use instead. An empty list
retrieves nothing. A rejection propagates as a request error rather than
falling back to the defaults: a failed policy lookup must not decide scope.

**A hook can never widen retrieval for a caller the surface could not
identify.** Without a sender, its answer is filtered down to the buckets the
mode would have retrieved anyway, so a hook asking for `private` from the
public chat route, from the API-key-gated `/v1` endpoint, or from an MCP public
tool has it dropped. Narrowing is always honoured. The buckets a surface
retrieves by default are unchanged, so private knowledge stays where it was:
out of reach of the public pipeline.

Note the granularity this operates at. `base`, `public` and `private` are the
buckets `config/knowledge` ingests, and those are the ones a stock deployment
can gate. Additional bucket names resolve and query fine, but nothing ingests
them — the knowledge builder only walks the three directories, and prunes rows
it did not write — so a custom bucket needs its own ingestion and its own
pruning strategy before it holds anything.

The same resolution is exported for channels and custom routes, which should
use it rather than hand-rolling the check — it is the single place the ceiling
is enforced:

```ts
import { resolveBuckets, prepareChat } from "@diegoaltoworks/chatter";

const buckets = await resolveBuckets({ mode: "public", sender, bucketsFor: config.bucketsFor });
const { system, messages } = await prepareChat({ store, prompts, mode: "public", messages: turns, buckets });
```

`prepareChat`'s own `buckets` parameter is the low-level primitive and takes
whatever it is given, so anything derived from request input belongs on the
`resolveBuckets` path first.

## Bringing your own brain (`answerFn`)

Prompt shaping stops at the completion call. `answerFn` replaces the call
itself, so an agent framework, a graph runtime, or a remote service can produce
the answer while Chatter keeps everything around it — retrieval and prompt
assembly upstream, and auth, rate limiting, transports and output guardrails
downstream:

```ts
const server = await createServer({
  // ...
  answerFn: async ({ system, messages, mode, sender }) => {
    const result = await myAgent.invoke({ system, messages });
    return result.text; // or { content, usage }
  },
});
```

`answerFn` is consulted by every chat surface: the widget chat routes, the
OpenAI-compatible endpoints, and the MCP chat tools. It receives the system
prompt exactly as `prepareChat` assembled it, the conversation, the pipeline
`mode`, and — where the surface knows one — a `sender` identity (the built-in
HTTP surfaces do not pass one, even on the private routes, whose JWT subject is
currently used only for retrieval scope).

Return a string, or an object with `content` and optional `usage` for the
surfaces that report token counts (a plain string reports zero usage). A
rejection surfaces as a normal completion error rather than silently falling
back to the built-in completion.

Guardrails still apply to whatever comes back — and because a brain's answer
arrives whole, it gets the leakage check as well as credential scrubbing, where
the built-in stream can only scrub each delta as it passes. A streamed brain
answer is therefore held to the stricter of the two checks.

Streaming surfaces keep their wire format: a brain that returns a whole answer
at once is delivered as a single chunk followed by the stream's normal end, so
`stream: true` clients need no changes. Leave `answerFn` unset and the built-in
OpenAI completion is used, unchanged.

For programmatic use, `answerOnce` and `answerStream` are exported and take the
same `answerFn` argument the routes pass:

```ts
import { prepareChat, answerOnce } from "@diegoaltoworks/chatter";

const { system, messages } = await prepareChat({ store, prompts, mode: "public", messages: turns });
const { content } = await answerOnce({ answerFn, client, system, messages, mode: "public" });
```

## Graph frameworks (LangGraph and similar)

`answerFn` and the OpenAI-compatible endpoint are also the seams for
combining Chatter with a graph-based agent framework such as
[LangGraph](https://langchain-ai.github.io/langgraphjs/), in either
direction:

- **A graph as Chatter's brain.** Wire the graph's `invoke` call into
  `answerFn` (see above). Chatter keeps retrieval, prompt assembly, auth,
  rate limiting and output guardrails; the graph only produces the answer
  text from the assembled system prompt and conversation.
- **Chatter as a node inside a graph.** Point the graph's chat model at
  Chatter's `/v1/chat/completions` endpoint (`baseURL` + API key, same as any
  OpenAI-compatible client). Chatter contributes one RAG-grounded,
  guardrailed step; the rest of the graph is free to add other models, tools
  or formatting around it.

Both directions are runnable in
[`examples/langgraph-brain`](../examples/langgraph-brain/).

### When does a graph fit?

Chatter's built-in pipeline is deliberately linear: retrieve, assemble a
prompt, answer once. That is enough for most chat surfaces, including
multi-turn structured interactions handled by [flows](./flows.md)
(Chatter's own designated home for schema-driven, multi-turn slot filling).

Reach for a graph framework instead when a single turn needs multiple
LLM or tool-calling steps that don't reduce to "retrieve, then answer" — a
research agent that plans and re-plans, a turn that fans out to several
tools before composing a reply, or orchestration shared with other
graph-based systems you already run. Chatter's core stays framework-free
either way: no graph library is a dependency or peer dependency of the
package, so choosing one costs nothing for deployments that don't.

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
