import type { Context, Next } from "hono";
import type { ChatterConfig } from "../types";

const DEFAULT_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: https:; connect-src 'self' https:; frame-ancestors 'self'";

const DEFAULT_HSTS = "max-age=15552000; includeSubDomains";

function isHttps(c: Context, trustProxy: boolean): boolean {
  if (new URL(c.req.url).protocol === "https:") return true;
  if (!trustProxy) return false;
  // `X-Forwarded-For` is documented (clientKey.ts) as only trustworthy behind
  // a proxy that overwrites client-supplied values; `X-Forwarded-Proto` is the
  // same kind of client-suppliable header, so it's gated by the same flag.
  return c.req.header("x-forwarded-proto")?.toLowerCase() === "https";
}

/**
 * Sets baseline security headers on every response: a Content-Security-Policy
 * (governs pages this server itself renders — see `server.contentSecurityPolicy`),
 * `X-Content-Type-Options` to stop MIME sniffing, and HSTS (see
 * `server.strictTransportSecurity`). HSTS is only sent when the request
 * actually arrived over HTTPS (directly, or via a trusted proxy's
 * `X-Forwarded-Proto` — see `rateLimit.trustProxy`) or `NODE_ENV=production`.
 * A browser ignores HSTS delivered over plain HTTP (RFC 6797 §8.1), so this
 * gate is about not asserting a guarantee the deployment doesn't back, not
 * about avoiding a localhost lockout. `trustProxy` defaults to `false`: a
 * deployment reachable directly must opt in before a client-suppliable
 * header is trusted for anything.
 *
 * Headers are set after `next()` so they still land on a handler that
 * returns a raw `Response` (e.g. from `config.customRoutes`) rather than
 * `c.json`/`c.text` — Hono only merges headers set before `next()` into
 * responses it builds itself.
 */
export function securityHeaders(config: ChatterConfig) {
  const csp = config.server?.contentSecurityPolicy || DEFAULT_CSP;
  const hsts = config.server?.strictTransportSecurity ?? DEFAULT_HSTS;
  const trustProxy = config.rateLimit?.trustProxy ?? false;

  return async (c: Context, next: Next) => {
    await next();
    c.header("content-security-policy", csp);
    c.header("x-content-type-options", "nosniff");
    if (hsts && (isHttps(c, trustProxy) || process.env.NODE_ENV === "production")) {
      c.header("strict-transport-security", hsts);
    }
  };
}
