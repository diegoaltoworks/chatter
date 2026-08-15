/**
 * Shared origin/referer matching for anything that gates on
 * `allowedOrigins` — demo access, referrer checks. Centralized so every
 * caller gets the same boundary-aware comparison instead of each
 * reimplementing (and re-breaking) it.
 */

/**
 * True when `origin` exactly equals one of `allowedOrigins`, or `referer`
 * equals one or is prefixed by one followed by `/` or `?`. A naive
 * `referer.startsWith(allowed)` would let `https://example.com.evil.com`
 * match an allowed `https://example.com` — the boundary check rejects that.
 */
export function matchesAllowedOrigin(
  origin: string | undefined,
  referer: string | undefined,
  allowedOrigins: string[],
): boolean {
  return allowedOrigins.some((allowed) => {
    if (origin === allowed) return true;
    if (referer) {
      if (referer === allowed) return true;
      if (referer.startsWith(`${allowed}/`)) return true;
      if (referer.startsWith(`${allowed}?`)) return true;
    }
    return false;
  });
}

/**
 * True when `value` is an `http(s)://localhost` or `http(s)://127.0.0.1`
 * origin, any port. Parses as a URL rather than checking a string prefix —
 * `value.startsWith("http://localhost:")` would also match
 * `http://localhost:8080.evil.com`, the same suffix-bypass class this module
 * exists to reject.
 */
function isLocalhost(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return url.hostname === "localhost" || url.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

/**
 * Same as {@link matchesAllowedOrigin}, plus any-port localhost/127.0.0.1 —
 * for local-dev convenience on surfaces that would otherwise require an
 * explicit `allowedOrigins` entry per dev port.
 *
 * `Origin`/`Referer` are only browser-enforced for browser-driven requests —
 * a direct (non-browser) client can set either to anything, same as it could
 * `Host`. This function is therefore not a substitute for real access
 * control; callers should only reach for it where an always-on localhost
 * allowance is an accepted tradeoff (typically gated behind an explicit
 * opt-in), never as a blanket replacement for `matchesAllowedOrigin`.
 */
export function matchesAllowedOriginOrLocalhost(
  origin: string | undefined,
  referer: string | undefined,
  allowedOrigins: string[],
): boolean {
  if (isLocalhost(origin) || isLocalhost(referer)) return true;
  return matchesAllowedOrigin(origin, referer, allowedOrigins);
}
