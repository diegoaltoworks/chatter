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

- [Bun](https://bun.sh) v1.0+
- Node.js 18+ (for compatibility testing)

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

### Commits

- Use clear and meaningful commit messages
- Follow conventional commits format:
  - `feat: add new feature`
  - `fix: resolve bug`
  - `docs: update documentation`
  - `test: add tests`
  - `refactor: restructure code`
  - `chore: maintenance tasks`

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
publish workflow re-runs the gates, builds, bumps the minor version, tags, and
publishes to npm with provenance. The tag push then publishes the GitHub
release notes. Do not bump `package.json` by hand — the workflow owns the
version.

One thing is deliberately **not** automatic: nothing authored by
`dependabot[bot]` publishes itself. Dependency PRs are opened, approved and
merged by bots, so releasing off one would ship an upstream change nobody read.
The publish job declines when dependabot authored the triggering commit, *and*
fails outright if dependabot authored anything since the last release tag — so
a bump cannot ride along inside a later release either. To ship a reviewed
bump, run the **Publish to NPM** workflow from the Actions tab; dispatching it
is the approval.

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
