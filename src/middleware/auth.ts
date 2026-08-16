import type { Context, Next } from "hono";
import type { ServerDependencies } from "../types";

/**
 * Create authentication middleware for public API endpoints
 * Supports session keys and JWT API keys (via ApiKeyManager)
 */
export function createAuthMiddleware(deps: ServerDependencies) {
  const { apiKeyManager, logger } = deps;

  return async function requirePublicKey(c: Context, next: Next) {
    const hdr = c.req.header("x-api-key");

    // Session keys are validated by validateSessionKey middleware
    // Allow them through if they've passed that validation
    if (hdr?.startsWith("session_")) {
      logger.debug(`[Auth] Session key allowed: ${hdr.slice(0, 20)}...`);
      await next();
      return;
    }

    // Verify JWT API key using ApiKeyManager
    if (!apiKeyManager) {
      logger.debug("[Auth] No API key manager configured");
      return c.json({ error: "Unauthorized - API key authentication not configured" }, 401);
    }

    if (!hdr) {
      logger.debug("[Auth] No API key provided");
      return c.json({ error: "Unauthorized - Missing x-api-key header" }, 401);
    }

    try {
      const result = await apiKeyManager.verify(hdr);
      if (result.valid) {
        const payload = result.payload as { name?: string; sub?: string };
        logger.debug(`[Auth] JWT API key authorized: ${payload.name || payload.sub || "unknown"}`);
        await next();
        return;
      }
      logger.debug(`[Auth] JWT verification failed: ${result.error}`);
    } catch (error) {
      // Unlike the per-request decisions above, `verify` throwing is a
      // defect signal (a misbehaving custom ApiKeyManager, a JWKS fetch
      // failure) rather than routine traffic — worth surfacing by default.
      logger.warn(`[Auth] JWT verification error: ${error}`);
    }

    // No valid authentication found
    logger.debug(`[Auth] Invalid API key: ${hdr?.slice(0, 20) || "none"}`);
    return c.json({ error: "Unauthorized" }, 401);
  };
}
