import type { Context, Next } from "hono";
import { jwtVerify } from "jose";
import type { ChatterConfig } from "../types";

/**
 * Create authentication middleware for public API endpoints
 * Supports session keys, JWT API keys, and static API keys
 */
export function createAuthMiddleware(config: ChatterConfig) {
  const chatbotSecret = config.auth?.publicApiKey; // Used for CHATBOT_SECRET env var
  const chatbotApiKey = config.auth?.publicApiKey;

  return async function requirePublicKey(c: Context, next: Next) {
    const hdr = c.req.header("x-api-key");

    // Session keys are validated by validateSessionKey middleware
    // Allow them through if they've passed that validation
    if (hdr?.startsWith("session_")) {
      console.log(`[Auth] Session key allowed: ${hdr.slice(0, 20)}...`);
      await next();
      return;
    }

    // Try JWT verification if CHATBOT_SECRET is configured and header looks like a JWT
    // Note: We check process.env first for testability
    const secret = process.env.CHATBOT_SECRET || chatbotSecret;
    if (secret && hdr && hdr.includes(".")) {
      try {
        const secretBytes = new TextEncoder().encode(secret);
        const { payload } = await jwtVerify(hdr, secretBytes);

        // Verify it's an API key type token
        if (payload.type === "api_key") {
          console.log(`[Auth] JWT API key authorized: ${payload.name || payload.sub || "unknown"}`);
          await next();
          return;
        }
      } catch (error) {
        // JWT verification failed, fall through to check static key
        console.log(`[Auth] JWT verification failed: ${error}`);
      }
    }

    // Check static public key (legacy support)
    // Note: We check process.env first for testability
    const apiKey = process.env.CHATBOT_API_KEY || chatbotApiKey;
    if (apiKey && hdr === apiKey) {
      console.log("[Auth] Static API key authorized");
      await next();
      return;
    }

    // No valid authentication found
    console.log(`[Auth] Invalid API key: ${hdr?.slice(0, 20) || "none"}`);
    return c.json({ error: "Unauthorized" }, 401);
  };
}

// Backward compatibility export (will be removed when routes are updated)
export const requirePublicKey = createAuthMiddleware({} as ChatterConfig);
