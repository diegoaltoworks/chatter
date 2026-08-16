/**
 * Referrer checking middleware
 * Validates that requests with demo API keys come from allowed origins
 */

import type { Context, Next } from "hono";
import { createConsoleLogger, type Logger } from "../core/logger";
import { SESSION_KEY_PREFIX } from "../core/session";
import { API_KEY_HEADER, API_KEY_PREVIEW_LENGTH } from "./apiKey";
import { matchesAllowedOrigin } from "./originMatch";

/**
 * Middleware to check if the request comes from an allowed origin
 * Only applies to demo API keys and session keys - production keys bypass this check
 *
 * @param demoApiKeys - API key values treated as demo keys (see
 * `ChatterConfig.rateLimit.demoApiKeys`). Unset: no key is a demo key.
 */
export function requireReferrer(
  allowedOrigins: string[],
  demoApiKeys: string[] = [],
  logger: Logger = createConsoleLogger(),
) {
  return async (c: Context, next: Next) => {
    const apiKey = c.req.header(API_KEY_HEADER);

    // Check referrer for demo keys AND session keys
    const isDemoKey = apiKey ? demoApiKeys.includes(apiKey) : false;
    const isSessionKey = apiKey?.startsWith(SESSION_KEY_PREFIX);

    if (isDemoKey || isSessionKey) {
      const referer = c.req.header("referer");
      const origin = c.req.header("origin");

      logger.debug(
        `[Referrer] Checking ${isSessionKey ? "session" : "demo"} key: ${apiKey?.slice(0, API_KEY_PREVIEW_LENGTH)}...`,
      );
      logger.debug(`[Referrer] Origin: ${origin || "none"}, Referer: ${referer || "none"}`);

      const isAllowed = matchesAllowedOrigin(origin, referer, allowedOrigins);

      if (!isAllowed) {
        logger.debug(`[Referrer] BLOCKED - not from allowed origins: ${allowedOrigins.join(", ")}`);
        return c.json(
          {
            error:
              "Demo API keys only work on official demo pages. Please visit our website or use your own API key.",
          },
          403,
        );
      }

      logger.debug("[Referrer] Allowed - origin matches");
    }

    await next();
  };
}

// Export with create* name for public API consistency
export const createReferrerCheck = requireReferrer;
