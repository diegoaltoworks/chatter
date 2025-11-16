/**
 * Session key validation middleware
 */

import type { Context, Next } from "hono";
import { getSessionInfo, validateSession } from "../core/session";

/**
 * Middleware to validate session-based temporary API keys
 * Session keys start with "session_" prefix
 */
export function validateSessionKey() {
  return async (c: Context, next: Next) => {
    const apiKey = c.req.header("x-api-key");

    // Only validate keys that look like session keys
    if (apiKey?.startsWith("session_")) {
      console.log(`[Session] Validating key: ${apiKey.slice(0, 20)}...`);

      const info = getSessionInfo(apiKey);
      if (info) {
        console.log(
          `[Session] Key found - requests: ${info.requests}/${info.maxRequests}, expires: ${new Date(info.expiresAt).toISOString()}`,
        );
      } else {
        console.log("[Session] Key not found in session store");
      }

      const isValid = validateSession(apiKey);

      if (!isValid) {
        console.log("[Session] REJECTED - expired or quota exceeded");
        return c.json(
          {
            error:
              "Session expired or quota exceeded. Please refresh the page to get a new session.",
          },
          401,
        );
      }

      console.log("[Session] Valid - request count incremented");
    }

    await next();
  };
}

// Export with create* name for public API consistency
export const createSessionMiddleware = validateSessionKey;
