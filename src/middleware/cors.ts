import type { Context, Next } from "hono";
import { API_KEY_HEADER } from "./apiKey";

const ALLOWED_HEADERS = `content-type, ${API_KEY_HEADER}, authorization, x-conversation-id`;
const ALLOWED_METHODS = "POST, GET, OPTIONS";
const EXPOSED_HEADERS = "x-conversation-id";

/**
 * CORS middleware that validates requests against allowed origins.
 *
 * @param allowedOrigins - Array of permitted origins. When the array contains
 *   `"*"` (or is empty/undefined), all origins are allowed. Otherwise only
 *   the listed origins receive CORS headers.
 */
export const cors = (allowedOrigins?: string[]) => async (c: Context, next: Next) => {
  const requestOrigin = c.req.header("origin");
  const allowAll = !allowedOrigins || allowedOrigins.length === 0 || allowedOrigins.includes("*");
  const originHeader = resolveOrigin(requestOrigin, allowedOrigins, allowAll);

  if (c.req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": originHeader,
        "access-control-allow-headers": ALLOWED_HEADERS,
        "access-control-allow-methods": ALLOWED_METHODS,
        "access-control-expose-headers": EXPOSED_HEADERS,
        ...(allowAll ? {} : { vary: "Origin" }),
      },
    });
  }

  c.header("access-control-allow-origin", originHeader);
  c.header("access-control-allow-headers", ALLOWED_HEADERS);
  c.header("access-control-allow-methods", ALLOWED_METHODS);
  c.header("access-control-expose-headers", EXPOSED_HEADERS);
  if (!allowAll) {
    c.header("vary", "Origin");
  }

  await next();
};

/**
 * Determine the value for the `Access-Control-Allow-Origin` header.
 *
 * - When all origins are allowed, returns `"*"`.
 * - When a specific allowlist is provided, echoes the request origin back
 *   if it matches; otherwise returns the first allowed origin (browsers
 *   will block the response when it doesn't match).
 */
function resolveOrigin(
  requestOrigin: string | undefined,
  allowedOrigins: string[] | undefined,
  allowAll: boolean,
): string {
  if (allowAll) return "*";

  // biome-ignore lint: allowedOrigins is guaranteed non-empty when allowAll is false
  if (requestOrigin && allowedOrigins!.includes(requestOrigin)) {
    return requestOrigin;
  }

  // Fallback: return first allowed origin (browser will reject the mismatch)
  // biome-ignore lint: allowedOrigins is guaranteed non-empty when allowAll is false
  return allowedOrigins![0];
}
