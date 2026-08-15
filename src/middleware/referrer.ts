/**
 * Referrer checking middleware
 * Validates that requests with demo API keys come from allowed origins
 */

import type { Context, Next } from "hono";
import { matchesAllowedOrigin } from "./originMatch";

/**
 * Middleware to check if the request comes from an allowed origin
 * Only applies to demo API keys and session keys - production keys bypass this check
 *
 * @param demoApiKeys - API key values treated as demo keys (see
 * `ChatterConfig.rateLimit.demoApiKeys`). Unset: no key is a demo key.
 */
export function requireReferrer(allowedOrigins: string[], demoApiKeys: string[] = []) {
  return async (c: Context, next: Next) => {
    const apiKey = c.req.header("x-api-key");

    // Check referrer for demo keys AND session keys
    const isDemoKey = apiKey ? demoApiKeys.includes(apiKey) : false;
    const isSessionKey = apiKey?.startsWith("session_");

    if (isDemoKey || isSessionKey) {
      const referer = c.req.header("referer");
      const origin = c.req.header("origin");

      console.log(
        `[Referrer] Checking ${isSessionKey ? "session" : "demo"} key: ${apiKey?.slice(0, 20)}...`,
      );
      console.log(`[Referrer] Origin: ${origin || "none"}, Referer: ${referer || "none"}`);

      const isAllowed = matchesAllowedOrigin(origin, referer, allowedOrigins);

      if (!isAllowed) {
        console.log(`[Referrer] BLOCKED - not from allowed origins: ${allowedOrigins.join(", ")}`);
        return c.json(
          {
            error:
              "Demo API keys only work on official demo pages. Please visit our website or use your own API key.",
          },
          403,
        );
      }

      console.log("[Referrer] Allowed - origin matches");
    }

    await next();
  };
}

// Export with create* name for public API consistency
export const createReferrerCheck = requireReferrer;
