# Git Commit Policy

## Commit Message Format

When creating git commits, use SIMPLE, CLEAN commit messages with NO additional attribution or footers.

### ✅ CORRECT Format

```
git commit -m "Update chatter dependency to 0.1.4"
```

```
git commit -m "Add API key validation"
```

### ❌ NEVER DO THIS

**NEVER add these to commit messages:**
- `Co-Authored-By: Claude <noreply@anthropic.com>`
- `🤖 Generated with [Claude Code](https://claude.com/claude-code)`
- Any AI attribution footers
- Any emoji markers
- Any trailers indicating AI assistance

## Why

The user wants commits to appear as normal human commits without any indication of AI assistance. Clean, professional commit messages only.

## Implementation

Use simple `git commit -m "message"` format. Never use HEREDOCs or multi-line commit messages with attribution trailers.
