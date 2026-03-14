# Chatter Testing Documentation

> **Note:** This document has been superseded by comprehensive testing documentation in `docs/testing/README.md`.
> This file is kept for backward compatibility.

For complete testing documentation, see:
- **[Complete Testing Guide](./docs/testing/README.md)** - Comprehensive testing documentation
- **[Code Quality Review](./docs/CODE_QUALITY.md)** - Security, architecture, and quality assessment

## Testing Structure

```
chatter/
├── src/
│   ├── auth/
│   │   ├── apikeys.ts
│   │   └── apikeys.test.ts           ✅ Unit tests
│   ├── core/
│   │   ├── guardrails.ts
│   │   ├── guardrails.test.ts        ✅ Unit tests
│   │   ├── llm.ts
│   │   ├── llm.test.ts               ⚠️  TODO (mocking required)
│   │   ├── loaders.ts
│   │   ├── loaders.test.ts           ⚠️  TODO
│   │   ├── prompts.ts
│   │   ├── prompts.test.ts           ✅ Unit tests
│   │   ├── retrieval.ts
│   │   ├── retrieval.test.ts         ⚠️  TODO (complex, needs mocking)
│   │   ├── session.ts
│   │   ├── session.test.ts           ✅ Unit tests
│   │   └── widgets.ts
│   │       └── widgets.test.ts       ⚠️  TODO
│   ├── middleware/
│   │   ├── auth.test.ts              ⚠️  TODO
│   │   ├── cors.test.ts              ⚠️  TODO
│   │   ├── jwt.test.ts               ⚠️  TODO
│   │   ├── ratelimit.test.ts         ⚠️  TODO
│   │   ├── referrer.test.ts          ⚠️  TODO
│   │   └── session.test.ts           ⚠️  TODO
│   └── routes/
│       ├── public.test.ts            ⚠️  TODO
│       ├── private.test.ts           ⚠️  TODO
│       └── demo.test.ts              ⚠️  TODO
└── test/
    └── integration/
        ├── public-routes.test.ts     ✅ Integration tests
        ├── private-routes.test.ts    ⚠️  TODO
        ├── demo-routes.test.ts       ⚠️  TODO
        └── server.test.ts            ⚠️  TODO
```

## Test Categories

### Unit Tests (Co-located with modules)

Unit tests are placed **next to the module they test** (e.g., `apikeys.test.ts` next to `apikeys.ts`).

**Completed:**
- ✅ **auth/apikeys.test.ts** - 40+ tests covering:
  - API key creation with various options
  - JWT verification (valid/invalid/expired)
  - Expiration time parsing (seconds, minutes, hours, days, months, years)
  - Token decoding without verification
  - Edge cases and error handling

- ✅ **core/guardrails.test.ts** - 20+ tests covering:
  - Prompt injection detection (system prompt, hidden instructions, rules leakage)
  - Secret scrubbing (OpenAI keys, Google API keys)
  - Case-insensitive pattern matching
  - Integration scenarios

- ✅ **core/session.test.ts** - 25+ tests covering:
  - Session creation with custom options
  - Request quota validation and enforcement
  - Session expiration and cleanup
  - Metadata storage and retrieval
  - Edge cases (zero TTL, zero quota, etc.)

- ✅ **core/prompts.test.ts** - 20+ tests covering:
  - Template variable interpolation ({{botName}}, {{personName}}, {{personFirstName}})
  - Multi-word name handling
  - Multiple bot instances
  - Edge cases (empty names, static prompts)

**Still Needed:**
- ⚠️  **core/llm.test.ts** - Mock OpenAI client, test completeOnce/completeStream
- ⚠️  **core/loaders.test.ts** - Test markdown file loading from different buckets
- ⚠️  **core/retrieval.test.ts** - Mock database, test chunking, embeddings, vector search
- ⚠️  **core/widgets.test.ts** - Test static asset resolution
- ⚠️  **middleware/*.test.ts** - Test all middleware with mock Hono context
- ⚠️  **routes/*.test.ts** - Test route handlers with mocked dependencies

### Integration Tests (test/integration/)

Integration tests verify complete flows across multiple components.

**Completed:**
- ✅ **test/integration/public-routes.test.ts** - 15+ tests covering:
  - Full authentication flow (API keys, session keys)
  - Request validation (single message, message arrays)
  - CORS headers and preflight
  - RAG integration with knowledge base
  - Health and config endpoints
  - End-to-end request/response validation

**Still Needed:**
- ⚠️  **test/integration/private-routes.test.ts** - JWT auth, private knowledge access
- ⚠️  **test/integration/demo-routes.test.ts** - Session creation, rate limiting
- ⚠️  **test/integration/server.test.ts** - Server creation with various configs

## Running Tests

```bash
# Run all tests
bun test

# Run only unit tests
bun run test:unit

# Run only integration tests
bun run test:integration

# Watch mode (re-run on file changes)
bun run test:watch

# Coverage report
bun run test:coverage
```

## Test Environment Requirements

### Unit Tests
- No external dependencies required
- All unit tests use mocks/fakes for I/O
- Fast execution (< 1 second for full suite)

### Integration Tests
- **Required Environment Variables:**
  - `OPENAI_API_KEY` - For LLM calls (actual API calls are made)
  - `TURSO_URL` - Database URL (uses real database)
  - `TURSO_AUTH_TOKEN` - Database authentication

- Integration tests will **skip gracefully** if environment variables are missing
- Tests create temporary directories and clean up after completion

## Testing Patterns

### Unit Test Pattern

```typescript
import { describe, expect, it, beforeEach } from "bun:test";
import { YourModule } from "./your-module";

describe("YourModule", () => {
  describe("methodName", () => {
    it("should handle normal case", () => {
      // Arrange
      const input = "test";
      
      // Act
      const result = yourFunction(input);
      
      // Assert
      expect(result).toBe("expected");
    });

    it("should handle edge case", () => {
      expect(() => yourFunction(null)).toThrow();
    });
  });
});
```

### Integration Test Pattern

```typescript
import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { createServer } from "../../src/server";

describe("Feature Integration", () => {
  let app;

  beforeAll(async () => {
    // Skip if required env vars missing
    if (!process.env.OPENAI_API_KEY) return;

    // Setup test environment
    app = await createServer(testConfig);
  });

  afterAll(() => {
    // Cleanup
  });

  it("should complete full flow", async () => {
    if (!app) return; // Skip if setup failed

    const req = new Request("http://localhost/api/endpoint");
    const res = await app.fetch(req);
    
    expect(res.status).toBe(200);
  });
});
```

## Coverage Goals

| Module | Unit Tests | Integration Tests | Status |
|--------|-----------|------------------|--------|
| **auth/** | ✅ 100% | ✅ Covered | Complete |
| **core/guardrails** | ✅ 100% | N/A | Complete |
| **core/session** | ✅ 100% | ✅ Covered | Complete |
| **core/prompts** | ✅ 100% | ✅ Covered | Complete |
| **core/llm** | ⚠️ 0% | ✅ Covered | Needs unit tests |
| **core/loaders** | ⚠️ 0% | ✅ Covered | Needs unit tests |
| **core/retrieval** | ⚠️ 0% | ✅ Covered | Needs unit tests |
| **core/widgets** | ⚠️ 0% | N/A | Needs unit tests |
| **middleware/** | ⚠️ 0% | ✅ Partial | Needs unit tests |
| **routes/** | ⚠️ 0% | ✅ Partial | Needs unit tests |
| **server** | N/A | ⚠️ Partial | Needs more integration tests |

## Next Steps

### High Priority
1. ✅ Complete core module unit tests (loaders, llm, retrieval, widgets)
2. ✅ Add middleware unit tests (auth, jwt, cors, ratelimit, referrer, session)
3. ✅ Add route handler unit tests
4. ✅ Complete integration test suite (private routes, demo routes, server)

### Medium Priority
5. Add client library tests (ChatBot, Chat, ChatButton)
6. Add end-to-end tests with real browser (Playwright)
7. Performance/load testing

### Continuous
- Maintain test coverage above 80%
- Add tests for all new features
- Update tests when fixing bugs

## Contributing Tests

When adding new features:

1. **Write unit tests first** (TDD approach recommended)
2. **Place tests next to the module** (`module.test.ts`)
3. **Follow existing patterns** (describe/it blocks, arrange/act/assert)
4. **Test edge cases** (empty input, null, undefined, errors)
5. **Use descriptive test names** ("should reject expired API key")
6. **Add integration tests** for API changes or new routes

## Test Quality Standards

- ✅ Tests should be **fast** (< 100ms per unit test)
- ✅ Tests should be **isolated** (no shared state between tests)
- ✅ Tests should be **deterministic** (no flaky tests)
- ✅ Tests should be **readable** (clear arrange/act/assert structure)
- ✅ Tests should **not depend on external services** (use mocks for unit tests)
- ✅ Integration tests should **clean up** after themselves

## Debugging Tests

```bash
# Run specific test file
bun test src/auth/apikeys.test.ts

# Run specific test by name pattern
bun test --test-name-pattern="API key creation"

# Verbose output
bun test --verbose

# Bail on first failure
bun test --bail
```

## CI/CD Integration

Tests run automatically on:
- ✅ Pre-commit (lint-staged)
- ✅ Pull requests (GitHub Actions)
- ✅ Pre-publish (prepublishOnly script)

---

**Legend:**
- ✅ Complete
- ⚠️  TODO / Incomplete
- N/A - Not applicable
