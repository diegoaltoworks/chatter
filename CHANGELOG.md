# Changelog

Per-release notes are generated automatically from commit/PR history when a
version is published - see [GitHub Releases](https://github.com/diegoaltoworks/chatter/releases)
for the current and complete history. This file is not kept in sync with that
automation; entries below stop shortly after 0.5.0 and are retained only as a
historical record of changes made before releases were automated.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Breaking

- **`ServerDependencies` gains a required `identities` field** (a
  `SessionIdentityRegistry`). `createServer` constructs and shares it with
  every channel automatically, so the supported composition -
  `createServer` plus `customRoutes` or the returned `ChatterApp` - is
  unaffected. A host that constructs a `ServerDependencies` object itself,
  outside `createServer`, must add the field.
- **A message from another of a process's own bot identities is now ignored
  on Telegram and Matrix**, matching WhatsApp's existing behaviour, instead
  of being answered as if it came from a stranger. A deployment running
  several of its own bots in one process that relied on them answering each
  other needs separate processes, or separate `createServer` calls, to keep
  that behaviour.

A deployment keeps byte-identical conversation ids and needs no migration
only when every channel is left at its default, single, unnamed endpoint:
`endpointId` is set as soon as a channel is configured with more than one
endpoint, *or* given a custom `name` - see [The endpoint that received a
message](./docs/channels.md#the-endpoint-that-received-a-message). A
deployment already passing a `name` picks up an `endpointId`, and therefore a
new conversation history key, on upgrade even though it only ever ran one
endpoint under that name. Opting a channel into `endpointId` for the first
time, by either path, is a one-way door for stored history - see the same
section - so review it before naming a previously-unnamed channel or adding
a second endpoint to one that already carries history.

### Added
- **OpenAI-compatible endpoints**: `POST /v1/chat/completions` (public pipeline, API key auth) and `POST /api/private/v1/chat/completions` (private pipeline, JWT auth), with SSE streaming (`chat.completion.chunk` + `[DONE]`) and non-streaming responses. Any OpenAI-format chat UI or SDK can now be the front end. Disable with `features.enableOpenAICompat: false`.
- **Headless mode**: `features.headless: true` runs the server as a pure API - widget assets and static/demo pages are not served.
- **Exported chat pipeline**: `prepareChat` (RAG retrieval + system prompt assembly) is exported for programmatic use, fully decoupled from HTTP and the widget.
- **UI integration examples**: runnable sample apps for [Deep Chat](https://deepchat.dev) (`examples/deep-chat`) and [assistant-ui](https://www.assistant-ui.com) (`examples/assistant-ui`), plus a new [integrations guide](./docs/integrations.md).
- **Injectable guardrail refusal copy**: `answerOnce`/`answerStream`/`completeOnce` accept a per-call `refusal`, and `BrainHooks.refusal` sets a channel- or server-level default, so a host can voice the leak-guard refusal in its own character instead of chatter's built-in English copy. A host that configures nothing sees byte-identical behaviour.
- **Framework-owned identity registry**: `createServer` builds one `SessionIdentityRegistry` per call and shares it with every channel as `deps.identities`, so cross-transport loop protection (see the Breaking section above) is the default rather than something a host wires by hand.
- **`ChannelMessage.endpointId`** and `conversationKeyFor(chatId, endpointId)` (exported from the `chatter/channels` subpath) let a host bind conversation history to which of its own endpoints received a message, not only to who sent it - see [The endpoint that received a message](./docs/channels.md#the-endpoint-that-received-a-message).
- **Endpoint-keyed persona resolution**: `resolvePersonaLayer`/`rollPersonaId` (from `chatter/personas`) accept either a bare contact id (unchanged) or `{ contactId, endpointId }`, and a registry's new `endpoints` map binds a persona to an endpoint deterministically, without the contact path's probability roll. A single-endpoint deployment on any transport passes no `endpointId` and keeps today's contact-only resolution exactly as before - see [Resolving on the endpoint that was reached](./docs/personas.md#resolving-on-the-endpoint-that-was-reached).

## Changes after 0.5.0

All released - see GitHub Releases for exact version numbers.

### Fixed
- `config.openai.model` is now respected; previously all completions were hard-coded to `gpt-4o`.

### Security
- The OpenAI-compatible endpoints ignore client-supplied `model` (server config decides spend) and drop incoming `system`/`tool` messages (the server owns guardrails and persona).
- **Markdown rendering in chat widget**: Assistant messages now render a safe subset of Markdown (headings, bold/italic, inline + fenced code, lists, blockquotes, links, horizontal rules). All input is HTML-escaped and link URLs are restricted to a `http(s):/mailto:/#` allowlist to prevent XSS.

## [0.5.0] - 2025-11-16

### Added
- **API Key Management System**: Built-in JWT-based API key creation and verification
- **CLI Tool**: `npx chatter create-apikey` command for generating API keys
- **ApiKeyManager Class**: Programmatic API key creation and verification
- Automatic widget serving from `/chatter.js` and `/chatter.css` endpoints
- Mobile-optimized chat widgets with iOS/Android-specific fixes
- RAG-powered chatbot with OpenAI embeddings and Turso vector database
- Customizable chat widgets (ChatBot, Chat, ChatButton)
- Authentication support (JWT, Clerk, custom providers)
- Rate limiting and CORS middleware
- Security guardrails for input validation
- TypeScript support with full type definitions
- Streaming response support
- Knowledge base management from markdown files
- Session management with session keys
- Prompt template system

### Changed
- **Breaking**: `createAuthMiddleware` now takes `ServerDependencies` instead of `ChatterConfig`
- Authentication config simplified: use `auth.secret` for JWT keys instead of managing them manually
- Widget files now served directly from package's `dist/widgets/` directory

### Fixed
- Widget path resolution when package installed in `node_modules`
- Mobile viewport handling with iOS safe area insets
- CSS class naming consistency (all prefixed with `chatter-ui-`)

### Documentation
- Comprehensive README with API key management guide
- Contributing guidelines and Code of Conduct
- Issue and PR templates
- Example implementations

[0.5.0]: https://github.com/diegoaltoworks/chatter/releases/tag/v0.5.0
