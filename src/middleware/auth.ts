import type { Context, Next } from "hono";
import type { ServerDependencies } from "../types";

/**
 * Create authentication middleware for public API endpoints
 * Supports session keys and JWT API keys (via ApiKeyManager)
 */
export function createAuthMiddleware(deps: ServerDependencies) {
  const { apiKeyManager } = deps;

  return async function requirePublicKey(c: Context, next: Next) {
    const hdr = c.req.header("x-api-key");

    // Session keys are validated by validateSessionKey middleware
    // Allow them through if they've passed that validation
    if (hdr?.startsWith("session_")) {
      console.log(`[Auth] Session key allowed: ${hdr.slice(0, 20)}...`);
      await next();
      return;
    }

    // Verify JWT API key using ApiKeyManager
    if (!apiKeyManager) {
      console.log("[Auth] No API key manager configured");
      return c.json({ error: "Unauthorized - API key authentication not configured" }, 401);
    }

    if (!hdr) {
      console.log("[Auth] No API key provided");
      return c.json({ error: "Unauthorized - Missing x-api-key header" }, 401);
    }

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

    // No valid authentication found
    console.log(`[Auth] Invalid API key: ${hdr?.slice(0, 20) || "none"}`);
    return c.json({ error: "Unauthorized" }, 401);
  };
}
