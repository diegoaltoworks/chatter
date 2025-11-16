# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/diegoaltoworks/chatter/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/diegoaltoworks/chatter/releases/tag/v0.5.0
