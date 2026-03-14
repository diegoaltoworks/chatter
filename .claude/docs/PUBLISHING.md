# Publishing @fyne/chatbot to NPM

This document outlines the plan and steps for publishing the client library to npm.

## Package Overview

- **Package Name**: `@fyne/chatbot`
- **Description**: Isomorphic chatbot client library for embedding AI chat widgets
- **Type**: Dual-mode ESM/UMD library
- **Runtime Support**: Browser and Node.js
- **License**: MIT

## Prerequisites

Before publishing, ensure you have:

1. **NPM Account**: Create account at [npmjs.com](https://www.npmjs.com/)
2. **Scope Access**: Request access to `@fyne` scope OR use `@your-scope`
3. **NPM Auth**: Run `npm login` to authenticate
4. **Version Strategy**: Follow [semver](https://semver.org/) (e.g., 1.0.0)

## Pre-Publishing Checklist

### 1. Update package.json

The `src/client/package.json` needs these fields configured:

```json
{
  "name": "@fyne/chatbot",
  "version": "1.0.0",
  "description": "Isomorphic chatbot client - embeddable AI chat widgets",
  "main": "dist/index.js",
  "module": "dist/index.esm.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.esm.js",
      "require": "./dist/index.js"
    },
    "./style.css": "./dist/styles.css"
  },
  "files": [
    "dist",
    "README.md",
    "LICENSE"
  ],
  "keywords": [
    "chatbot",
    "ai",
    "chat",
    "widget",
    "rag",
    "openai",
    "embed",
    "isomorphic",
    "browser",
    "nodejs"
  ],
  "author": "Your Name <your@email.com>",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/yourusername/diegobot.git",
    "directory": "src/client"
  },
  "bugs": {
    "url": "https://github.com/yourusername/diegobot/issues"
  },
  "homepage": "https://github.com/yourusername/diegobot#readme",
  "publishConfig": {
    "access": "public"
  }
}
```

### 2. Add README.md

Create `src/client/README.md` with:

- Installation instructions
- Quick start examples (CDN and npm)
- API documentation for ChatBot, Chat, ChatButton
- Configuration options
- TypeScript usage examples
- License information

### 3. Add LICENSE

Create `src/client/LICENSE` file (MIT recommended):

```
MIT License

Copyright (c) 2025 [Your Name]

[... standard MIT license text ...]
```

### 4. Build the Library

The build script must generate:

```
src/client/dist/
├── index.js          # CommonJS bundle
├── index.esm.js      # ES Module bundle
├── index.d.ts        # TypeScript definitions
└── styles.css        # Compiled CSS
```

Build command:
```bash
bun run build:client
```

### 5. Test the Package Locally

Before publishing, test the package locally:

```bash
# In src/client directory
npm pack

# This creates fyne-chatbot-1.0.0.tgz

# Test in another project
cd /path/to/test-project
npm install /path/to/diegobot/src/client/fyne-chatbot-1.0.0.tgz

# Verify imports work
import { ChatBot } from '@fyne/chatbot';
import '@fyne/chatbot/style.css';
```

## Publishing Steps

### Option 1: Manual Publish

```bash
# 1. Navigate to client directory
cd src/client

# 2. Ensure you're logged in
npm whoami
# If not logged in: npm login

# 3. Build the library
bun run build

# 4. Verify package contents
npm pack --dry-run

# 5. Publish to npm
npm publish --access public

# For scoped packages, first publish requires --access public
# Subsequent publishes don't need this flag
```

### Option 2: Automated Publish with CI/CD

Create `.github/workflows/publish-client.yml`:

```yaml
name: Publish Client to NPM

on:
  push:
    tags:
      - 'v*'  # Trigger on version tags like v1.0.0

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Bun
        uses: oven-sh/setup-bun@v1

      - name: Install dependencies
        run: bun install

      - name: Build client library
        run: bun run build:client

      - name: Setup Node.js for NPM
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          registry-url: 'https://registry.npmjs.org'

      - name: Publish to NPM
        working-directory: src/client
        run: npm publish --access public
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

Add `NPM_TOKEN` to GitHub repository secrets:
1. Generate token at [npmjs.com/settings/tokens](https://www.npmjs.com/settings/tokens)
2. Add to GitHub: Settings → Secrets → Actions → New repository secret

## Version Management

### Semantic Versioning

- **Major (1.0.0 → 2.0.0)**: Breaking API changes
- **Minor (1.0.0 → 1.1.0)**: New features, backward compatible
- **Patch (1.0.0 → 1.0.1)**: Bug fixes, backward compatible

### Updating Version

```bash
cd src/client

# Patch release (bug fix)
npm version patch

# Minor release (new feature)
npm version minor

# Major release (breaking change)
npm version major

# This updates package.json and creates a git tag
```

## Post-Publishing Tasks

### 1. Verify Publication

```bash
# Check package page
open https://www.npmjs.com/package/@fyne/chatbot

# Test installation
npm install @fyne/chatbot

# Verify on unpkg CDN (takes ~5 minutes)
open https://unpkg.com/@fyne/chatbot@latest/
```

### 2. Update CDN Links

After publishing, update demo pages to reference CDN version:

```html
<!-- Instead of local /chatbot.css -->
<link rel="stylesheet" href="https://unpkg.com/@fyne/chatbot@1/dist/styles.css">

<!-- Instead of local /chatbot.min.js -->
<script src="https://unpkg.com/@fyne/chatbot@1/dist/index.js"></script>
```

### 3. Create GitHub Release

```bash
# Tag the release
git tag v1.0.0 -m "Release v1.0.0"
git push origin v1.0.0

# Create release on GitHub
# - Go to Releases → Draft new release
# - Select the tag
# - Add changelog
# - Publish release
```

### 4. Announce

- Update main README.md with npm install instructions
- Create announcement (Twitter, blog, etc.)
- Update documentation site if applicable

## Unpublishing (Emergency Only)

If you published a broken version within 72 hours:

```bash
# Unpublish specific version
npm unpublish @fyne/chatbot@1.0.0

# Deprecate without unpublishing
npm deprecate @fyne/chatbot@1.0.0 "This version has critical bugs. Use 1.0.1+"
```

⚠️ **Warning**: Unpublishing breaks all users on that version. Only use for security issues or critical bugs.

## Maintenance

### Regular Updates

1. Keep dependencies updated
2. Monitor npm for security advisories
3. Respond to GitHub issues
4. Review and merge pull requests
5. Release patches for bug fixes

### Monitoring

- **Downloads**: Check [npm stats](https://npm-stat.com/charts.html?package=@fyne/chatbot)
- **Issues**: Monitor GitHub issues for bug reports
- **Security**: Enable Dependabot alerts
- **Bundle Size**: Monitor with [bundlephobia](https://bundlephobia.com/)

## Troubleshooting

### "You do not have permission to publish"

```bash
# Verify you're logged in
npm whoami

# Check package name isn't taken
npm view @fyne/chatbot

# Use --access public for scoped packages
npm publish --access public
```

### "Version already exists"

```bash
# Check current published version
npm view @fyne/chatbot version

# Bump version
npm version patch

# Then publish again
npm publish
```

### TypeScript Definitions Not Working

Ensure:
- `tsconfig.json` has `"declaration": true`
- `package.json` has `"types": "dist/index.d.ts"`
- Build generates `.d.ts` files

## Alternative: GitHub Package Registry

To publish to GitHub instead of npm:

```bash
# Add to package.json
"publishConfig": {
  "registry": "https://npm.pkg.github.com"
}

# Login to GitHub registry
npm login --registry=https://npm.pkg.github.com

# Publish
npm publish
```

## Resources

- [NPM Publishing Docs](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages)
- [Semantic Versioning](https://semver.org/)
- [Package.json Fields](https://docs.npmjs.com/cli/v10/configuring-npm/package-json)
- [NPM Scripts](https://docs.npmjs.com/cli/v10/using-npm/scripts)

---

**Status**: Plan ready, not yet executed.
**Next Step**: Complete pre-publishing checklist before first publish.
