import type { Context, Next } from "hono";
import type { ServerDependencies } from "../types";

/**
 * Create authentication middleware for public API endpoints
 * Supports session keys, JWT API keys (via ApiKeyManager), and static API keys
 */
export function createAuthMiddleware(deps: ServerDependencies) {
  const { config, apiKeyManager } = deps;
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

    // Try JWT verification using ApiKeyManager (if configured)
    if (apiKeyManager && hdr && hdr.includes(".")) {
      try {
        const result = await apiKeyManager.verify(hdr);
        if (result.valid) {
          const payload = result.payload as { name?: string; sub?: string };
          console.log(`[Auth] JWT API key authorized: ${payload.name || payload.sub || "unknown"}`);
          await next();
          return;
        }
        console.log(`[Auth] JWT verification failed: ${result.error}`);
      } catch (error) {
        console.log(`[Auth] JWT verification error: ${error}`);
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
