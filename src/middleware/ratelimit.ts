import type { Context, Next } from "hono";
import type { ChatterConfig } from "../types";

interface ContextWithJWT extends Context {
  jwtSub?: string;
}

type BucketState = { count: number; windowStart: number };

// Demo API keys that get stricter rate limits
const DEMO_KEYS = ["fyneworks.key.here"];

function getKeyFromIP(c: Context) {
  const h = c.req.header("x-forwarded-for");
  if (h) return h.split(",")[0].trim();
  // Bun/Hono: remote address not directly exposed; you can append a reverse proxy that sets XFF.
  return "unknown-ip";
}

/**
 * Create rate limiter middleware
 * Returns an object with limitPublic and limitPrivate middleware functions
 */
export function createRateLimiter(config: ChatterConfig) {
  const buckets = new Map<string, BucketState>();
  const WINDOW_MS = 60_000;

  const publicLimit = config.rateLimit?.public || 60;
  const privateLimit = config.rateLimit?.private || 120;

  function allow(key: string, limit: number) {
    const now = Date.now();
    const b = buckets.get(key) ?? { count: 0, windowStart: now };
    if (now - b.windowStart >= WINDOW_MS) {
      b.count = 0;
      b.windowStart = now;
    }
    b.count += 1;
    buckets.set(key, b);
    return b.count <= limit;
  }

  return {
    // Public: key is IP only
    // Demo keys get 10x stricter rate limits
    limitPublic() {
      return async (c: Context, next: Next) => {
        const apiKey = c.req.header("x-api-key");
        const isDemoKey = apiKey ? DEMO_KEYS.includes(apiKey) : false;

        const key = `pub:${getKeyFromIP(c)}`;
        const limit = isDemoKey
          ? Math.floor(publicLimit / 10) // Demo: 10x stricter
          : publicLimit;

        if (!allow(key, limit)) {
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
        if (!allow(key, privateLimit)) return c.json({ error: "Rate limit" }, 429);
        await next();
      };
    },
  };
}

// Backward compatibility exports (will be removed when routes are updated)
const defaultLimiter = createRateLimiter({} as ChatterConfig);
export const limitPublic = defaultLimiter.limitPublic;
export const limitPrivate = defaultLimiter.limitPrivate;
