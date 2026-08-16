# Contributing to Chatter

Thank you for your interest in contributing to Chatter! This document provides guidelines and instructions for contributing.

## Code of Conduct

By participating in this project, you agree to abide by our Code of Conduct (see CODE_OF_CONDUCT.md).

## How Can I Contribute?

### Reporting Bugs

Before creating bug reports, please check existing issues. When creating a bug report, include as many details as possible using our bug report template.

### Suggesting Enhancements

Enhancement suggestions are tracked as GitHub issues. Create an issue using the feature request template and provide:

- A clear and descriptive title
- A detailed description of the proposed feature
- Examples of how the feature would be used
- Why this enhancement would be useful

### Pull Requests

1. Fork the repo and create your branch from `main`
2. If you've added code that should be tested, add tests
3. If you've changed APIs, update the documentation
4. Ensure the test suite passes
5. Make sure your code lints
6. Issue the pull request!

## Development Setup

### Prerequisites

- [Bun](https://bun.sh) v1.2+ (the development runtime; see `engines` in `package.json`)
- Node.js 24+ (the published package's floor — `test:node` verifies the built package boots under it)

### Setup

```bash
# Clone your fork
git clone https://github.com/YOUR_USERNAME/chatter.git
cd chatter

# Install dependencies
bun install

# Install client dependencies
cd src/client && bun install && cd ../..
```

### Development Workflow

```bash
# Run tests
bun test

# Run tests in watch mode
bun test --watch

# Type check
bun run typecheck

# Lint
bun run lint

# Fix linting issues
bun run lint:fix

# Build
bun run build
```

## Project Structure

```
chatter/
├── src/
│   ├── core/          # Core functionality (RAG, sessions, etc.)
│   ├── middleware/    # Auth, rate limiting, CORS
│   ├── routes/        # API route handlers
│   ├── client/        # Browser widgets
│   ├── server.ts      # Server factory
│   ├── index.ts       # Main exports
│   └── types.ts       # TypeScript types
├── .github/           # GitHub workflows and templates
└── dist/              # Build output (generated)
```

## Coding Guidelines

### TypeScript

- Use TypeScript for all new code
- Prefer interfaces over types for object shapes
- Use strict mode
- Document public APIs with JSDoc comments

### Code Style

- Use Biome for linting and formatting
- 2 spaces for indentation
- Double quotes for strings
- Semicolons required
- Max line length: 100 characters

### Testing

- Write tests for all new features
- Maintain or improve code coverage
- Use descriptive test names
- Group related tests with `describe` blocks

### Documentation

- **No untested numbers.** A doc must not state a benchmark, a latency, a
  size, a count, or any other figure that no test asserts. A number nobody
  checks silently goes stale the first time the code it described changes,
  and a stale number is worse than no number — it reads as authoritative.
  Either point at what pins the figure (`bundle-size budget: see
  BUNDLE_BUDGETS in scripts/pack-exports.ts, measured by bun run test:pack`)
  or phrase it qualitatively instead ("fast", "bounded", "under the
  tarball's size budget").

### Commits

- Use clear and meaningful commit messages
- Follow conventional commits format:
  - `feat: add new feature`
  - `fix: resolve bug`
  - `docs: update documentation`
  - `test: add tests`
  - `refactor: restructure code`
  - `chore: maintenance tasks`
- A husky `commit-msg` hook runs `commitlint` (config:
  `commitlint.config.js`, extending `@commitlint/config-conventional`) and
  rejects a commit whose message isn't a conventional-commit subject. This
  is a local guardrail, not a CI check: on `main` the commit that actually
  drives the release version is the squash-merge commit, whose subject is
  the PR title, composed on GitHub and never passed through this hook —
  keep the PR title itself conventional-commit shaped.
- Mark a breaking change with `!` before the colon (`feat!:`, `fix(api)!:`) or
  a `BREAKING CHANGE:` footer in the commit body. Past 1.0 this ships a major
  version; before 1.0 it still only reaches minor (see Release Process).

## Definition of Done

What "done" requires depends on what kind of change it is. This table is the
specific version of "add tests and update docs" — which test to extend, not
just that one exists. See [ARCHITECTURE.md](docs/ARCHITECTURE.md) for the
invariants these tests protect, and [docs/patterns/](docs/patterns/) for the
worked walkthroughs.

| Change type | Required steps | Test to extend |
| --- | --- | --- |
| **New chat surface** (route, channel, MCP tool) | Answer through `prepareChat` → `answerOnce`/`answerStream`, never `completeOnce`/`completeStream` directly | `scripts/architecture-invariants.test.ts` (automatic) + a surface-level test proving `answerFn` is honoured |
| **New hook/seam** (like `answerFn`, `bucketsFor`) | Pure decision function with an explicit ceiling/default; document narrowing vs. widening | A dedicated `*.test.ts` beside the seam proving the ceiling can't be bypassed |
| **New subpath** (optional integration) | Follow [docs/patterns/adding-a-capability.md](docs/patterns/adding-a-capability.md): `build:<name>` script, optional peer dependency, `exports` key last | `bun run test:pack` — packs the real tarball and resolves every declared `exports` key against it, so a new key is checked without editing the test |
| **New config field** | Additive, optional, safe default (existing behaviour unchanged when unset) | `test/api-surface.test.ts` (compiled via `bun run typecheck:api-surface`) + the relevant `test/integration/*.test.ts` |
| **New store** (Turso-backed persistence) | Follow [docs/patterns/adding-a-store.md](docs/patterns/adding-a-store.md): idempotent `CREATE TABLE IF NOT EXISTS`, validated table name, atomic claim | A store-level test against a real in-memory libsql client |
| **New doc** (`docs/*.md`) | Link it from both README.md's Documentation section and docs/index.md's Quick Navigation | `scripts/docs-toc.test.ts` (automatic) |
| **New/edited CI workflow** | Pin third-party actions to a commit SHA + version comment, pin Bun to the shared exact version, use `--frozen-lockfile` | `scripts/supply-chain.test.ts` (automatic) |

Every "automatic" test above is a `*.test.ts` under `scripts/` that reads
this repo's real files — `bun test` (part of `bun run check`) runs it without
any extra step on your part; you only need to make the change conform.

## Pull Request Process

1. **Update Documentation**: Update README.md and relevant docs for any new features
2. **Add Tests**: Ensure new code is covered by tests
3. **Pass CI**: All tests, linting, and type checks must pass
4. **Request Review**: Tag maintainers for review

Release notes are generated automatically from commit/PR history when a
version publishes (see [GitHub Releases](https://github.com/diegoaltoworks/chatter/releases))
— there's no CHANGELOG.md entry to add by hand.

## Release Process

Releases are automated. Merging a PR to `main` runs CI; when CI is green the
publish workflow re-runs the gates, builds, verifies the packed tarball and the
built package under Node, bumps the version, tags, publishes to npm with
provenance, and cuts the GitHub release with its notes. Do not bump
`package.json` by hand — the workflow owns the version.

The bump type is derived from the conventional-commit type of every commit
since the last release tag (not just the one that triggered the run): any
`feat` commit ships a minor, everything else (`fix`, `chore`, `docs`, etc.)
ships a patch. A breaking change — a `!` before the colon (`feat!:`) or a
`BREAKING CHANGE:` / `BREAKING-CHANGE:` footer in the commit body — ships a
major once the package is past 1.0; before 1.0 it still only reaches minor,
since semver leaves 0.x compatibility undefined and minor is already the
strongest signal available. See `scripts/next-version.ts` for the
derivation.

One thing is deliberately **not** automatic: nothing authored by
`dependabot[bot]` triggers its own release. Dependency PRs are opened, approved
and merged by bots, so releasing off one would ship an upstream change nobody
read. The publish job declines when dependabot authored the triggering commit,
and `scripts/release-guard.ts` scans everything since the last release tag so a
change cannot ride along inside a later release either. That scan blocks on a
bump that edits a workflow, a Dockerfile or source — anything that changes what
*runs* — and lets a manifest- or lockfile-only bump through, since it ships no
upstream code and the gates run against it like any other commit. To ship a
blocked change, review it and run the **Publish to NPM** workflow from the
Actions tab; dispatching is the approval, and it moves the tag past the commit.

The rest of the chain is pinned so that "CI was green" means something
specific: every third-party action is referenced by commit SHA (with a `# vX.Y.Z`
comment so Dependabot can still offer updates), Bun is pinned to one exact
version shared by the workflows and the Dockerfile, and every install runs
`--frozen-lockfile`. `scripts/supply-chain.test.ts` audits all of that, so a
new workflow or a copy-pasted step fails the gates rather than quietly opening
the path back up. See [Packaging](docs/packaging.md) for the full chain.

## Questions?

Feel free to:
- Open an issue for questions
- Start a discussion in GitHub Discussions
- Email: diego@diegoalto.works

Thank you for contributing! 🎉
