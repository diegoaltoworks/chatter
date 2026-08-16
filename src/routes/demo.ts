/**
 * Demo routes - No API key required
 * Includes aggressive rate limiting and session management
 */

import type { Context } from "hono";
import { Hono } from "hono";
import { stream } from "hono/streaming";
import { answerOnce, answerStream } from "../core/answer";
import { resolveBuckets } from "../core/buckets";
import { DEFAULT_MODEL } from "../core/llm";
import { lastUserMessage, normalizeChatBody } from "../core/messages";
import { prepareChat } from "../core/pipeline";
import { createSession, getActiveSessions } from "../core/session";
import { chatBodyLimit } from "../middleware/bodyLimit";
import { clientRateLimitKey } from "../middleware/clientKey";
import { matchesAllowedOrigin, matchesAllowedOriginOrLocalhost } from "../middleware/originMatch";
import { createWindowBucketLimiter } from "../middleware/windowBucket";
import type { ServerDependencies } from "../types";

/**
 * Check if origin/referer is allowed for demo routes.
 *
 * When `allowedOrigins` contains `"*"` or is empty, all origins are allowed.
 * Otherwise the request must match `allowedOrigins` via `Origin`/`Referer` —
 * never the `Host` header, which a direct (non-browser) client can set to
 * anything and would otherwise bypass the check entirely. `allowLocalhost`
 * (from `server.allowLocalhostDemo`, opt-in) additionally permits any-port
 * localhost/127.0.0.1 for local dev.
 */
function checkDemoOrigin(allowedOrigins: string[], allowLocalhost: boolean) {
  const allowAll = allowedOrigins.length === 0 || allowedOrigins.includes("*");
  const matches = allowLocalhost ? matchesAllowedOriginOrLocalhost : matchesAllowedOrigin;

  return async (c: Context, next: () => Promise<void>) => {
    // When no explicit origins are configured, allow everything
    if (allowAll) {
      return next();
    }

    const origin = c.req.header("origin");
    const referer = c.req.header("referer");

    if (matches(origin, referer, allowedOrigins)) {
      return next();
    }

    return c.json(
      {
        error: "Demo access restricted to authorized domains",
      },
      403,
    );
  };
}

/**
 * Session key creation rate limiter
 * 10 session keys per hour per IP
 */
function limitSessionCreation(trustProxy: boolean) {
  const limiter = createWindowBucketLimiter(3600_000); // 1 hour
  const LIMIT = 10; // 10 session keys per hour

  return async (c: Context, next: () => Promise<void>) => {
    const key = `session:${clientRateLimitKey(c, trustProxy)}`;

    if (!limiter.hit(key, LIMIT)) {
      return c.json(
        {
          error: "Session key limit exceeded (10 per hour). Please wait or use your own API key.",
        },
        429,
      );
    }

    await next();
  };
}

/**
 * Demo chat rate limiter
 * 10 requests per minute per IP - much stricter than public API
 */
function limitDemo(trustProxy: boolean) {
  const limiter = createWindowBucketLimiter(60_000);
  const LIMIT = 10; // 10 requests per minute

  return async (c: Context, next: () => Promise<void>) => {
    const key = `demo:${clientRateLimitKey(c, trustProxy)}`;

    if (!limiter.hit(key, LIMIT)) {
      return c.json(
        {
          error:
            "Demo rate limit exceeded (10 requests/minute). Please wait or use your own API key.",
        },
        429,
      );
    }

    await next();
  };
}

export function demoRoutes(deps: ServerDependencies) {
  const { client, store, config, prompts, logger } = deps;
  const app = new Hono();

  // Derive demo allowed origins from configured origins, falling back to allow-all
  const demoOrigins = config.server?.allowedOrigins ?? [];
  const allowLocalhostDemo = config.server?.allowLocalhostDemo ?? false;
  const trustProxy = config.rateLimit?.trustProxy ?? false;

  /**
   * GET /api/demo/session
   * Create a temporary session key for demos
   * Protected by origin check and rate limiting (10 per hour per IP)
   */
  app.get(
    "/api/demo/session",
    checkDemoOrigin(demoOrigins, allowLocalhostDemo),
    limitSessionCreation(trustProxy),
    (c) => {
      const session = createSession({
        maxRequests: 20,
        ttl: 3600, // 1 hour
      });

      logger.debug(
        `[Demo] Created session: ${session.key.slice(0, 20)}... (${session.maxRequests} requests, ${3600}s TTL)`,
      );

      return c.json({
        key: session.key,
        expiresIn: 3600,
        maxRequests: session.maxRequests,
        message: "Use this temporary key in the x-api-key header",
      });
    },
  );

  /**
   * GET /api/demo/stats
   * Get demo usage statistics (for monitoring)
   */
  app.get("/api/demo/stats", (c) => {
    return c.json({
      activeSessions: getActiveSessions(),
    });
  });

  /**
   * POST /api/demo/chat
   * Demo chat endpoint - no API key required
   * Ultra-strict rate limiting by IP (10 req/min)
   */
  app.post(
    "/api/demo/chat",
    chatBodyLimit(config.server?.maxRequestBytes), // Reject oversized bodies first
    limitDemo(trustProxy),
    async (c) => {
      try {
        const body = await c.req.json().catch(() => ({}));

        // Accepts a single message or a conversation; client system/tool turns
        // are dropped so the server keeps sole ownership of the system prompt.
        const normalized = normalizeChatBody(body);
        if (!normalized.ok) {
          return c.json({ error: normalized.error }, 400);
        }
        const { messages } = normalized;
        if (!lastUserMessage(messages)) {
          return c.json({ error: "no user message found in conversation" }, 400);
        }

        // Retrieve context from knowledge base. The demo surface is anonymous,
        // so the hook may narrow the scope but not widen it.
        const buckets = await resolveBuckets({ mode: "public", bucketsFor: config.bucketsFor });
        const { system } = await prepareChat({ store, prompts, mode: "public", messages, buckets });
        const model = config.openai.model || DEFAULT_MODEL;

        // Check if streaming requested
        const url = new URL(c.req.url);
        const wantsStream = url.searchParams.get("stream") === "1";

        if (wantsStream) {
          return stream(c, async (s) => {
            for await (const delta of answerStream({
              answerFn: config.answerFn,
              client,
              system,
              messages,
              mode: "public",
              model,
            })) {
              await s.write(`data: ${JSON.stringify({ delta })}\n\n`);
            }
            await s.write("event: end\ndata: {}\n\n");
          });
        }

        // Non-streaming response
        const out = await answerOnce({
          answerFn: config.answerFn,
          client,
          system,
          messages,
          mode: "public",
          model,
        });
        return c.json({ reply: out.content });
      } catch (error) {
        const err = error as Error;
        logger.error("Demo chat error:", err);
        return c.json({ error: err.message || "Internal error" }, 500);
      }
    },
  );

  return app;
}
