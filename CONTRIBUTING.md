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
4. **Update Changelog**: Add entry to CHANGELOG.md under "Unreleased"
5. **Request Review**: Tag maintainers for review

## Release Process

Releases are automated via GitHub Actions:

1. Update version in `package.json`
2. Update `CHANGELOG.md`
3. Push to `main` branch
4. GitHub Actions will:
   - Run all tests and checks
   - Publish to NPM
   - Create GitHub release
   - Generate release notes

## Questions?

Feel free to:
- Open an issue for questions
- Start a discussion in GitHub Discussions
- Email: diego@diegoalto.works

Thank you for contributing! 🎉
