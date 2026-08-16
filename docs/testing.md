# Chatter Testing Guide

Comprehensive testing documentation for the Chatter AI chatbot framework.

## Quick Start

```bash
# Run all tests
bun test

# Run only unit tests (fast, no external dependencies)
bun test src/**/*.test.ts

# Run only integration tests (no credentials needed - see below)
bun test test/integration/**/*.test.ts

# Watch mode (re-run on file changes)
bun test --watch

# Coverage report
bun test --coverage
```

## Test Suite Overview

- **Unit tests** live beside the code they cover (`src/**/*.test.ts`) and need
  no credentials or network - external clients are faked and databases are
  in-memory.
- **Integration tests** live in `test/integration/` and run a real
  `createServer(config)` against an in-memory libsql database
  (`database.url: "file::memory:"`) with a faked `fetch` standing in for
  OpenAI (see `test/integration/harness.ts`) - no credentials needed, and
  nothing calls a paid API.
- **Client tests** cover the widget in `src/client/`.

- **Packaging tests** cover the published contract. The pure half - what the
  `exports` map demands, and which parts of it a tarball fails - is unit-tested
  in `scripts/`; the half that must actually build, pack and install runs
  separately as `bun run test:pack` (see [Packaging](./packaging.md)), because
  no test that imports from `src/` can see a broken subpath.

- **Supply-chain tests** cover the CI configuration itself, not the code it
  runs. `scripts/supply-chain.test.ts` reads every workflow in
  `.github/workflows/` plus the Dockerfile, and fails if an action is
  referenced by a mutable tag, Bun floats or drifts between the two, an install
  skips `--frozen-lockfile`, or a workflow that publishes loses its dependabot
  gate or its artifact checks (see [Packaging](./packaging.md)). These are the
  properties that keep a green CI run meaningful, and each is a line or two
  that nothing else would notice going missing. `scripts/release-guard.test.ts`
  covers the gate's own logic: which commits in an unreleased range may publish
  automatically, and which need a human to dispatch the release.

- **Docs ToC tests** cover documentation drift. `scripts/docs-toc.test.ts`
  reads every `docs/*.md` file and fails if either README.md's Documentation
  section or docs/index.md's Quick Navigation section forgot to link it - the
  same "nothing else would notice going missing" shape as the supply-chain
  check, applied to the doc set instead of CI config.

- **Node runtime tests** cover the other runtime the package supports. Every
  test above runs under Bun, where a `Bun` global exists and `require()` works
  inside ESM, so `bun run build && bun run test:node` loads `dist/` under plain
  Node and boots a server from it. That is where a Bun-only import or a
  `require()` left in an ESM bundle shows up.

Run `bun test` for the current counts; `bun run check` additionally typechecks,
lints and audits.

## Test Structure

```
chatter/
├── src/
│   ├── auth/
│   │   └── apikeys.test.ts           API key issue/verify
│   ├── core/
│   │   ├── answer.test.ts            answerFn hook + completion fallback
│   │   ├── buckets.test.ts           retrieval scope + the anonymous ceiling
│   │   ├── guardrails.test.ts        output scrubbing, leakage detection
│   │   ├── loaders.test.ts           knowledge loading
│   │   ├── pipeline.test.ts          prompt assembly, persona layering
│   │   ├── prompts.test.ts           prompt loader
│   │   ├── retrieval.test.ts         vector store connection wiring
│   │   ├── session.test.ts           session lifecycle
│   │   └── widgets.test.ts           static asset resolution
│   ├── middleware/
│   │   ├── auth.test.ts
│   │   ├── cors.test.ts
│   │   ├── jwt.test.ts
│   │   ├── ratelimit.test.ts
│   │   ├── referrer.test.ts
│   │   └── session.test.ts
│   ├── routes/
│   │   ├── chat.test.ts              chat route behaviour
│   │   └── openai.test.ts            OpenAI-compatible endpoints
│   ├── server.test.ts                custom-route mounting (sync + async)
│   └── client/
│       └── __tests__/
│           └── mobile-chat.test.ts   widget
└── test/
    └── integration/
        ├── public-routes.test.ts
        ├── private-routes.test.ts
        ├── demo-routes.test.ts
        └── server.test.ts
```

## Module Coverage

### Authentication & Security

#### auth/apikeys.test.ts
Tests JWT-based API key management:
- ✅ Key creation with custom options (name, expiration, claims)
- ✅ JWT verification (valid/invalid/expired/wrong signature)
- ✅ Expiration parsing (seconds, minutes, hours, days, months, years)
- ✅ Token decoding without verification
- ✅ Error handling and edge cases

**Security validated:** API key integrity, expiration enforcement, signature verification

#### middleware/auth.test.ts
Tests authentication middleware:
- ✅ API key validation (JWT and session keys)
- ✅ Expired token rejection
- ✅ Wrong secret detection
- ✅ Middleware chain behavior
- ✅ Custom API key manager support

**Security validated:** Request authentication, key verification flow

#### middleware/jwt.test.ts
Tests JWT authentication for private endpoints:
- ✅ PEM public key verification
- ✅ Issuer and audience validation
- ✅ Expired JWT rejection
- ✅ Signature verification
- ✅ Subject claim attachment to context

**Security validated:** JWT verification, claim validation, cryptographic signatures

### Core Security

#### core/guardrails.test.ts
Tests security guardrails:
- ✅ Prompt injection detection (system prompt leakage, hidden instructions)
- ✅ Secret scrubbing (OpenAI keys, Google API keys, generic patterns)
- ✅ Case-insensitive matching
- ✅ Integration scenarios (multiple threats)

**Security validated:** Prompt injection prevention, secret exposure prevention

#### middleware/referrer.test.ts
Tests origin validation:
- ✅ Referer checking for session/demo keys
- ✅ Subdomain attack prevention (e.g., `example.com.evil.com`)
- ✅ Multiple origin support
- ✅ Origin header validation

**Security validated:** CSRF protection, origin validation, subdomain attacks blocked

### Session & Rate Limiting

#### core/session.test.ts
Tests session management:
- ✅ Session creation with custom TTL and quotas
- ✅ Request counting and quota enforcement
- ✅ Expiration and automatic cleanup
- ✅ Metadata storage
- ✅ Edge cases (zero TTL, concurrent requests)

**Performance validated:** Session lifecycle, quota enforcement, cleanup

#### middleware/session.test.ts
Tests session validation middleware:
- ✅ Valid session key acceptance
- ✅ Expired session rejection
- ✅ Quota exceeded rejection
- ✅ Request count incrementing

**Performance validated:** Request throttling, session validation

#### middleware/ratelimit.test.ts
Tests rate limiting:
- ✅ Public endpoint limits (IP-based)
- ✅ Private endpoint limits (JWT subject-based)
- ✅ Demo key restrictions
- ✅ Rate window management
- ✅ X-Forwarded-For handling

**Performance validated:** Rate limiting enforcement, DDoS protection

### Request Handling

#### middleware/cors.test.ts
Tests CORS middleware:
- ✅ CORS headers on GET/POST requests
- ✅ OPTIONS preflight handling
- ✅ Allowed headers and methods
- ✅ Error response handling

**Compatibility validated:** Cross-origin requests, browser compatibility

#### core/prompts.test.ts
Tests prompt templating:
- ✅ Variable interpolation ({{botName}}, {{personName}}, {{personFirstName}})
- ✅ Multi-word name extraction
- ✅ Multiple bot instances
- ✅ Edge cases (empty names, no variables)

**Functionality validated:** Dynamic prompt generation, variable substitution

#### core/loaders.test.ts
Tests knowledge base loading:
- ✅ Markdown file loading from all buckets (base, public, private)
- ✅ Nested directory handling
- ✅ File filtering (.md only)
- ✅ Metadata preservation
- ✅ Custom directory paths

**Functionality validated:** Knowledge base initialization, file organization

#### core/widgets.test.ts
Tests static asset resolution:
- ✅ Auto-detection of static directories
- ✅ Explicit path configuration
- ✅ Path existence validation
- ✅ Absolute and relative paths

**Deployment validated:** Asset serving, path resolution

#### server.test.ts
Tests custom-route mounting through `createServer`, against an in-memory
database and an empty knowledge directory so no paid API is reachable:
- ✅ Async `customRoutes` fully awaited before the app is returned
- ✅ Synchronous mounts, including expression-bodied ones returning the app
- ✅ Database set-up done during the mount is visible to the first request
- ✅ A rejecting mount fails start-up instead of yielding a half-built app

**Plugin contract validated:** Async plugin mounting completes before readiness

### Integration Tests

#### test/integration/public-routes.test.ts
Tests public chat API:
- ✅ Full authentication flow
- ✅ Request validation (single/array messages)
- ✅ CORS headers
- ✅ RAG knowledge base integration
- ✅ Health and config endpoints

**End-to-end validated:** Public API flow, authentication, RAG

#### test/integration/private-routes.test.ts
Tests private chat API:
- ✅ JWT authentication flow
- ✅ Single message and conversation history
- ✅ Streaming support (SSE)
- ✅ Rate limiting
- ✅ Error handling

**End-to-end validated:** Private API flow, JWT auth, streaming

#### test/integration/demo-routes.test.ts
Tests demo functionality:
- ✅ Session creation
- ✅ Demo chat without API key
- ✅ Rate limiting for demos
- ✅ Stats endpoint

**End-to-end validated:** Demo mode, session management

#### test/integration/server.test.ts
Tests server configuration:
- ✅ Minimal configuration
- ✅ Health and config endpoints
- ✅ CORS enable/disable
- ✅ Feature toggles (public/private/demo)
- ✅ Custom routes
- ✅ Knowledge and prompt directories

**Configuration validated:** Server setup, feature flags, customization

### Client Tests

#### src/client/__tests__/mobile-chat.test.ts
Tests mobile chat widget:
- ✅ Viewport detection (mobile vs desktop)
- ✅ Mobile CSS styles (fullscreen, safe areas)
- ✅ Input focus behavior
- ✅ Touch interactions
- ✅ Keyboard handling
- ✅ Dynamic viewport units (dvh/dvw)
- ✅ Performance optimizations

**Mobile validated:** Responsive design, iOS/Android compatibility

**Modules not requiring dedicated unit tests:**
- `core/llm.ts` - Thin wrapper around OpenAI SDK (tested via integration)
- `routes/*.ts` - Route handlers (tested via `src/routes/*.test.ts` and integration)

## Environment Requirements

### Unit Tests
- ✅ **No external dependencies**
- ✅ All tests use mocks/fakes for I/O
- ✅ Fast execution (whole unit suite runs in seconds)
- ✅ Run in CI/CD without configuration

### Integration Tests
No environment variables or credentials needed:

**Behavior:**
- `createServer` runs for real against `database.url: "file::memory:"`
- A faked `fetch` answers OpenAI chat-completion and embedding requests
  locally (`test/integration/harness.ts`) - no network call leaves the process
- Creates temporary directories for test isolation
- Cleans up all resources after completion

## Testing Patterns

### Unit Test Pattern

```typescript
import { describe, expect, it } from "bun:test";
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

    it("should handle error case", () => {
      expect(() => yourFunction(null)).toThrow();
    });
  });
});
```

### Integration Test Pattern

```typescript
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createServer } from "../../src/server";
import {
  installFakeOpenAI,
  integrationConfig,
  setupIntegrationDirs,
} from "./harness";

describe("Feature Integration", () => {
  const dirs = setupIntegrationDirs("feature");
  const fakeOpenAI = installFakeOpenAI({ reply: "canned reply" });
  let app;

  beforeAll(async () => {
    app = await createServer(integrationConfig(dirs));
  });

  afterAll(() => {
    fakeOpenAI.restore();
    dirs.cleanup();
  });

  it("should complete full flow", async () => {
    const req = new Request("http://localhost/api/endpoint");
    const res = await app.fetch(req);

    expect(res.status).toBe(200);
  });
});
```

## Test Quality Standards

Our tests follow these principles:

- ✅ **Fast** - Unit tests run in <100ms each
- ✅ **Isolated** - No shared state between tests
- ✅ **Deterministic** - No flaky tests
- ✅ **Readable** - Clear arrange/act/assert structure
- ✅ **Independent** - Tests don't depend on external services (unit tests)
- ✅ **Clean** - Integration tests clean up after themselves

## Running Specific Tests

```bash
# Run specific test file
bun test src/auth/apikeys.test.ts

# Run specific test by name pattern
bun test --test-name-pattern="API key creation"

# Run tests in specific directory
bun test src/middleware/

# Verbose output
bun test --verbose

# Stop on first failure
bun test --bail
```

## Debugging Failed Tests

```bash
# Run with detailed output
bun test --verbose src/middleware/referrer.test.ts

# Check specific test
bun test --test-name-pattern="should reject referer"

# Enable debug logs
DEBUG=* bun test src/auth/apikeys.test.ts
```

## CI/CD Integration

Tests run automatically on:

- ✅ **Pre-commit** - Fast unit tests via lint-staged
- ✅ **Pull Requests** - Full suite via GitHub Actions
- ✅ **Pre-publish** - Verification before NPM release

### GitHub Actions Workflow

`.github/workflows/ci.yml` runs four jobs on every push and pull request:

| Job | What it proves |
| --- | --- |
| `check` | The gates - `bun run check` (typecheck, api-surface compile, lint, tests, audit) and a full build |
| `node-runtime` | The built bundles load and serve under plain Node (`bun run test:node`) |
| `package-contract` | Every `exports` subpath resolves from a packed tarball (`bun run test:pack`) |
| `docker` | The image builds |

The gates run through the single `check` script rather than as separate steps,
so a check added locally cannot be missing from CI.

## Contributing Tests

When adding new features:

1. **Write tests first** (TDD recommended)
2. **Place unit tests next to module** (`module.test.ts`)
3. **Follow existing patterns** (describe/it blocks)
4. **Test edge cases** (null, undefined, errors)
5. **Use descriptive names** ("should reject expired API key")
6. **Add integration tests** for API changes

### Test Checklist

- [ ] Unit test created next to module
- [ ] All public methods tested
- [ ] Edge cases covered (null, undefined, errors)
- [ ] Integration test added (if API/route change)
- [ ] Tests pass locally: `bun test`
- [ ] No console errors or warnings
- [ ] Documentation updated if needed

## Security Testing

Our security testing covers:

✅ **Authentication**
- JWT signature verification
- Token expiration enforcement
- Invalid token rejection

✅ **Authorization**
- Origin validation
- Referer checking
- Subdomain attack prevention

✅ **Input Validation**
- Prompt injection detection
- Secret scrubbing
- Request validation

✅ **Rate Limiting**
- Per-IP limiting (public)
- Per-user limiting (private)
- Demo key restrictions

✅ **CORS**
- Allowed origins
- Preflight requests
- Header validation

## Performance Testing

Rate limiting and quota tests validate:
- Request throttling
- Concurrent request handling
- Memory cleanup
- Session expiration

**Benchmarks:**
- Session creation: <1ms
- API key verification: <2ms
- Rate limit check: <1ms
- Full request cycle: <100ms (excl. LLM)

## Known Limitations

1. **Browser Tests** - Mobile widget tests use JSDOM (not real browser)
2. **Faked OpenAI** - Integration tests exercise the real request/response
   plumbing but not the model itself; nothing asserts real completion quality

## Future Improvements

### Short Term
- [ ] Add load testing (Apache Bench / k6)
- [ ] Add security scanning (Snyk / npm audit)
- [ ] Add mutation testing (Stryker)

### Long Term
- [ ] E2E tests with real browser (Playwright)
- [ ] Visual regression tests (Percy / Chromatic)
- [ ] Contract testing (Pact)

## Support

For testing questions:
- 📚 [Main Documentation](../README.md)
- 🐛 [GitHub Issues](https://github.com/diegoaltoworks/chatter/issues) - Discussions are not enabled; questions and bugs both go here
