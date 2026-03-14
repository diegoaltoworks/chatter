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
# MCP Server Integration - Implementation Summary

## Changes Made

### 1. Dependencies Added
- Added `@modelcontextprotocol/sdk` as peer dependency (^1.0.0)
- Added `zod` as peer dependency (^3.25.0)
- Installed both as dev dependencies for build process

### 2. New Files Created
- `src/mcp-server.ts` - Core MCP server implementation
- `examples/mcp-server-example.ts` - Example usage file

### 3. Package Configuration Updates
- Added new export path `./mcp` in package.json
  - Types: `./dist/mcp-server.d.ts`
  - ESM: `./dist/mcp-server.mjs`
  - CJS: `./dist/mcp-server.js`
- Added `build:mcp` script for building MCP server bundle
- Integrated MCP build into main build pipeline

### 4. Main Index Updates
- Exported `createMCPServer` factory function
- Exported `MCPServerOptions` and `MCPTransportMode` types

### 5. Documentation Updates
- Added MCP Server Integration section to README.md
- Included setup examples and Claude Desktop configuration

## MCP Server Features

### Exposed Tools
1. **chat_public** - Chat using public knowledge base
   - Supports single message or conversation history
   - RAG-powered with 6 context chunks
   - Uses base + public knowledge buckets

2. **chat_private** - Chat using private/internal knowledge base
   - Supports single message or conversation history
   - RAG-powered with 8 context chunks
   - Uses base + private knowledge buckets

### Transport Support
- STDIO transport (default) for local clients like Claude Desktop
- Both tools apply existing guardrails (detectLeakage, scrubOutput)

## Usage

### As Package Import
```typescript
import { createMCPServer } from '@diegoaltoworks/chatter/mcp';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = await createMCPServer({ /* config */ });
const transport = new StdioServerTransport();
await server.connect(transport);
```

### Claude Desktop Configuration
```json
{
  "mcpServers": {
    "chatter": {
      "command": "node",
      "args": ["/path/to/mcp-server.js"],
      "env": {
        "OPENAI_API_KEY": "...",
        "TURSO_URL": "...",
        "TURSO_AUTH_TOKEN": "..."
      }
    }
  }
}
```

## Build Output
- `dist/mcp-server.js` (14.9kb) - CommonJS bundle
- `dist/mcp-server.mjs` (13.0kb) - ES Module bundle
- `dist/mcp-server.d.ts` - TypeScript declarations

## Implementation Notes
- Reuses existing core modules (VectorStore, PromptLoader, completeOnce)
- Maintains consistency with existing Chatter server patterns
- Minimal code duplication - wraps existing chat logic
- Type-safe with full TypeScript support
- Follows MCP SDK best practices with Zod schemas

