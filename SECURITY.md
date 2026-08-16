# Security Policy

## Supported Versions

Chatter is pre-1.0 (currently 0.x). Only the latest published version receives
security fixes — there is no maintained back-branch.

## Security Scanning

### Automated Scans

1. **`bun audit --audit-level=moderate`** - Part of `bun run check`, which runs
   via CI's `check` job on pushes and PRs targeting `main`/`develop`. Fails the
   gate on moderate or higher severity issues.

2. **Dependabot** - Weekly (Monday) scheduled updates for npm, GitHub Actions,
   and the Dockerfile's Bun base image (see `.github/dependabot.yml`). CI runs
   on every dependency PR and a maintainer merges it; a dependabot-authored
   commit never triggers a publish on its own (see
   [Packaging](docs/packaging.md)).

CodeQL, TruffleHog secret scanning, and a dedicated dependency-review action
are not currently wired up in this repo — don't assume they're catching
anything until a workflow exists to prove it.

### Manual Security Checks

Run security scans locally before committing:

```bash
# Run security audit
bun run security:audit

# Run security check (fails on moderate+ vulnerabilities)
bun run security:check

# Fix automatically fixable vulnerabilities
bun run security:audit:fix

# Run full quality checks (includes security)
bun run check
```

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, please report them via email to: **diego@diegoalto.works**

You should receive a response within 48 hours. If for some reason you do not, please follow up via email to ensure we received your original message.

Please include the following information:

- Type of issue (e.g. buffer overflow, SQL injection, cross-site scripting, etc.)
- Full paths of source file(s) related to the manifestation of the issue
- The location of the affected source code (tag/branch/commit or direct URL)
- Any special configuration required to reproduce the issue
- Step-by-step instructions to reproduce the issue
- Proof-of-concept or exploit code (if possible)
- Impact of the issue, including how an attacker might exploit it

## Security Features

Chatter includes multiple built-in security features:

### Authentication & Authorization
- JWT-based API key management
- Session-based authentication with quotas
- Configurable expiration times
- Support for custom authentication providers

### Input Validation & Sanitization
- Prompt injection detection
- Secret scrubbing in outputs
- Request validation and sanitization
- SQL injection prevention (parameterized queries)

### Rate Limiting & DDoS Protection
- IP-based rate limiting for public endpoints
- JWT subject-based rate limiting for private endpoints
- Configurable request quotas
- Demo key restrictions

### CORS & Origin Validation
- Configurable CORS policies
- Origin/referer validation
- Subdomain attack prevention
- Preflight request handling

### Secure Defaults
- HTTPS-only cookies (production)
- Secure session management
- Automatic session cleanup
- Environment variable-based secrets

## Security Best Practices

When deploying Chatter:

1. **Use Environment Variables** for secrets
   ```bash
   export OPENAI_API_KEY="sk-..."
   export TURSO_URL="libsql://..."
   export CHATTER_SECRET="your-secret-key"
   ```

2. **Enable HTTPS** in production
   - Use a reverse proxy (nginx, Caddy)
   - Configure SSL/TLS certificates
   - Enable HSTS headers

3. **Configure Rate Limiting**
   ```typescript
   {
     rateLimit: {
       public: 60,      // Requests per minute
       private: 120     // Requests per minute
     }
   }
   ```

4. **Restrict Origins** for CORS
   ```typescript
   {
     server: {
       cors: {
         origin: ['https://yourdomain.com']
       }
     }
   }
   ```

5. **Monitor Logs** for suspicious activity
   - Failed authentication attempts
   - Rate limit violations
   - Unusual API usage patterns

6. **Keep Dependencies Updated**
   ```bash
   bun outdated
   bun update
   ```

7. **Use Strong Secrets**
   - Generate cryptographically secure secrets
   - Rotate secrets regularly
   - Never commit secrets to version control

## Vulnerability Disclosure Timeline

- **Day 0**: Vulnerability reported
- **Day 1-2**: Initial response and triage
- **Day 3-7**: Develop and test fix
- **Day 7-14**: Release security patch
- **Day 14+**: Public disclosure (coordinated)

## Security Hall of Fame

We recognize security researchers who responsibly disclose vulnerabilities:

<!-- Contributors will be listed here -->

## Security Contacts

- **Primary**: diego@diegoalto.works
- **GitHub**: [@diegoaltoworks](https://github.com/diegoaltoworks)

## Additional Resources

- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [Node.js Security Best Practices](https://nodejs.org/en/docs/guides/security/)
- [NPM Security](https://docs.npmjs.com/about-security-audits)
