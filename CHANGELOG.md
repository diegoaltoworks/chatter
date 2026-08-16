# Changelog

Per-release notes are generated automatically from commit/PR history when a
version is published - see [GitHub Releases](https://github.com/diegoaltoworks/chatter/releases)
for the current and complete history. This file is not kept in sync with that
automation; entries below stop shortly after 0.5.0 and are retained only as a
historical record of changes made before releases were automated.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adhered to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Changes after 0.5.0

All released - see GitHub Releases for exact version numbers.

### Added
- **OpenAI-compatible endpoints**: `POST /v1/chat/completions` (public pipeline, API key auth) and `POST /api/private/v1/chat/completions` (private pipeline, JWT auth), with SSE streaming (`chat.completion.chunk` + `[DONE]`) and non-streaming responses. Any OpenAI-format chat UI or SDK can now be the front end. Disable with `features.enableOpenAICompat: false`.
- **Headless mode**: `features.headless: true` runs the server as a pure API - widget assets and static/demo pages are not served.
- **Exported chat pipeline**: `prepareChat` (RAG retrieval + system prompt assembly) is exported for programmatic use, fully decoupled from HTTP and the widget.
- **UI integration examples**: runnable sample apps for [Deep Chat](https://deepchat.dev) (`examples/deep-chat`) and [assistant-ui](https://www.assistant-ui.com) (`examples/assistant-ui`), plus a new [integrations guide](./docs/integrations.md).

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
