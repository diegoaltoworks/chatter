/**
 * Demo routes - No API key required
 * Includes aggressive rate limiting and session management
 */

import type { Context } from "hono";
import { Hono } from "hono";
import { stream } from "hono/streaming";
import { completeOnce, completeStream } from "../core/llm";
import { createSession, getActiveSessions } from "../core/session";
import type { ServerDependencies } from "../types";

/**
 * Check if origin/referer is allowed for demo routes
 */
function checkDemoOrigin() {
  const allowedOrigins = [
    "https://bot.diegoalto.app",
    "https://diegoalto.co.uk",
    "http://diegoalto.co.uk",
    "https://diegoalto.works",
    "http://diegoalto.works",
  ];

  return async (c: Context, next: () => Promise<void>) => {
    const origin = c.req.header("origin");
    const referer = c.req.header("referer");
    const host = c.req.header("host") || "";

    // Allow localhost on any port
    if (host.startsWith("localhost:") || host.startsWith("127.0.0.1:")) {
      return next();
    }

    // Check origin
    if (origin) {
      const allowed = allowedOrigins.some((allowed) => origin.startsWith(allowed));
      if (allowed) return next();
    }

    // Check referer
    if (referer) {
      const allowed = allowedOrigins.some((allowed) => referer.startsWith(allowed));
      if (allowed) return next();
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
function limitSessionCreation() {
  const buckets = new Map<string, { count: number; windowStart: number }>();
  const WINDOW_MS = 3600_000; // 1 hour
  const LIMIT = 10; // 10 session keys per hour

  return async (c: Context, next: () => Promise<void>) => {
    const ip = c.req.header("x-forwarded-for")?.split(",")[0].trim() || "unknown-ip";
    const key = `session:${ip}`;
    const now = Date.now();

    const b = buckets.get(key) ?? { count: 0, windowStart: now };
    if (now - b.windowStart >= WINDOW_MS) {
      b.count = 0;
      b.windowStart = now;
    }
    b.count += 1;
    buckets.set(key, b);

    if (b.count > LIMIT) {
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
function limitDemo() {
  const buckets = new Map<string, { count: number; windowStart: number }>();
  const WINDOW_MS = 60_000;
  const LIMIT = 10; // 10 requests per minute

  return async (c: Context, next: () => Promise<void>) => {
    const ip = c.req.header("x-forwarded-for")?.split(",")[0].trim() || "unknown-ip";
    const key = `demo:${ip}`;
    const now = Date.now();

    const b = buckets.get(key) ?? { count: 0, windowStart: now };
    if (now - b.windowStart >= WINDOW_MS) {
      b.count = 0;
      b.windowStart = now;
    }
    b.count += 1;
    buckets.set(key, b);

    if (b.count > LIMIT) {
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
  const { client, store, prompts } = deps;
  const app = new Hono();

  /**
   * GET /api/demo/session
   * Create a temporary session key for demos
   * Protected by origin check and rate limiting (10 per hour per IP)
   */
  app.get("/api/demo/session", checkDemoOrigin(), limitSessionCreation(), (c) => {
    const session = createSession({
      maxRequests: 20,
      ttl: 3600, // 1 hour
    });

    console.log(
      `[Demo] Created session: ${session.key.slice(0, 20)}... (${session.maxRequests} requests, ${3600}s TTL)`,
    );

    return c.json({
      key: session.key,
      expiresIn: 3600,
      maxRequests: session.maxRequests,
      message: "Use this temporary key in the x-api-key header",
    });
  });

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
  app.post("/api/demo/chat", limitDemo(), async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));

      // Support both single message and conversation history
      let messages: { role: "user" | "assistant"; content: string }[];

      if (body?.messages && Array.isArray(body.messages)) {
        messages = body.messages;
        if (messages.length === 0) {
          return c.json({ error: "messages array cannot be empty" }, 400);
        }
      } else if (body?.message) {
        messages = [{ role: "user", content: String(body.message) }];
      } else {
        return c.json({ error: "either 'message' or 'messages' required" }, 400);
      }

      // Get the latest user message for RAG context
      const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
      if (!lastUserMsg) {
        return c.json({ error: "no user message found in conversation" }, 400);
      }

      // Retrieve context from knowledge base
      const ctx = await store.query(lastUserMsg.content, 6, ["base", "public"]);
      const system = [
        prompts.baseSystemRules,
        prompts.publicPersona,
        `Context:\n${ctx.join("\n\n")}`,
      ].join("\n\n");

      // Check if streaming requested
      const url = new URL(c.req.url);
      const wantsStream = url.searchParams.get("stream") === "1";

      if (wantsStream) {
        return stream(c, async (s) => {
          for await (const delta of completeStream({ client, system, messages })) {
            await s.write(`data: ${JSON.stringify({ delta })}\n\n`);
          }
          await s.write("event: end\ndata: {}\n\n");
        });
      }

      // Non-streaming response
      const out = await completeOnce({ client, system, messages });
      return c.json({ reply: out.content });
    } catch (error) {
      const err = error as Error;
      console.error("Demo chat error:", err);
      return c.json({ error: err.message || "Internal error" }, 500);
    }
  });

  return app;
}
