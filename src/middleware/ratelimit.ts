import type { Context, Next } from "hono";

import type { ChatterConfig } from "../types";
import { API_KEY_HEADER } from "./apiKey";
import { clientRateLimitKey } from "./clientKey";
import { createWindowBucketLimiter } from "./windowBucket";

interface ContextWithJWT extends Context {
  jwtSub?: string;
}

/**
 * Create rate limiter middleware
 * Returns an object with limitPublic and limitPrivate middleware functions
 */
export function createRateLimiter(config: ChatterConfig) {
  const limiter = createWindowBucketLimiter(60_000);

  const publicLimit = config.rateLimit?.public || 60;
  const privateLimit = config.rateLimit?.private || 120;
  const trustProxy = config.rateLimit?.trustProxy ?? false;
  const demoApiKeys = config.rateLimit?.demoApiKeys ?? [];

  return {
    // Public: key is IP only
    // Demo keys get 10x stricter rate limits
    limitPublic() {
      return async (c: Context, next: Next) => {
        const apiKey = c.req.header(API_KEY_HEADER);
        const isDemoKey = apiKey ? demoApiKeys.includes(apiKey) : false;

        const key = `pub:${clientRateLimitKey(c, trustProxy)}`;
        const limit = isDemoKey
          ? Math.floor(publicLimit / 10) // Demo: 10x stricter
          : publicLimit;

        if (!limiter.hit(key, limit)) {
          return c.json(
            {
              error: isDemoKey
                ? "Demo rate limit exceeded. Please use your own API key for higher limits."
                : "Rate limit exceeded",
            },
            429,
          );
        }
        await next();
      };
    },

    // Private: key is JWT subject only
    limitPrivate() {
      return async (c: Context, next: Next) => {
        const sub = (c as ContextWithJWT).jwtSub;
        const key = `private:${sub ?? "no-sub"}`;
        if (!limiter.hit(key, privateLimit)) return c.json({ error: "Rate limit" }, 429);
        await next();
      };
    },
  };
}
