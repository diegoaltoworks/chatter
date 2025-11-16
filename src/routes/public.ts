import type { Context } from "hono";
import { Hono } from "hono";
import { stream } from "hono/streaming";
import { completeOnce, completeStream } from "../core/llm";
import { createAuthMiddleware } from "../middleware/auth";
import { createRateLimiter } from "../middleware/ratelimit";
import { requireReferrer } from "../middleware/referrer";
import { validateSessionKey } from "../middleware/session";
import type { ServerDependencies } from "../types";

function wantsStream(c: Context) {
  const url = new URL(c.req.url);
  if (url.searchParams.get("stream") === "1") return true;
  const acc = c.req.header("accept") ?? "";
  return acc.includes("text/event-stream");
}

export function publicRoutes(deps: ServerDependencies) {
  const { client, store, config, prompts } = deps;
  const app = new Hono();

  // Create middleware instances from deps
  const requirePublicKey = createAuthMiddleware(deps);
  const { limitPublic } = createRateLimiter(config);

  // Security middleware stack
  app.use("/api/public/*", validateSessionKey()); // Validate session keys first
  app.use("/api/public/*", requirePublicKey); // Then check API key
  app.use(
    "/api/public/*",
    requireReferrer([config.bot.publicUrl, "http://localhost:8181", "http://127.0.0.1:8181"]),
  ); // Referrer checking for demo keys
  app.use("/api/public/*", limitPublic()); // Rate limiting (stricter for demo keys)

  app.post("/api/public/chat", async (c) => {
    const body = await c.req.json().catch(() => ({}));

    // Support both single message and conversation history
    let messages: { role: "user" | "assistant"; content: string }[];

    if (body?.messages && Array.isArray(body.messages)) {
      // Multi-turn conversation: array of messages
      messages = body.messages;
      if (messages.length === 0) {
        return c.json({ error: "messages array cannot be empty" }, 400);
      }
    } else if (body?.message) {
      // Single message (backward compatible)
      messages = [{ role: "user", content: String(body.message) }];
    } else {
      return c.json({ error: "either 'message' or 'messages' required" }, 400);
    }

    // Get the latest user message for RAG context
    const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
    if (!lastUserMsg) {
      return c.json({ error: "no user message found in conversation" }, 400);
    }

    const ctx = await store.query(lastUserMsg.content, 6, ["base", "public"]);
    const system = [
      prompts.baseSystemRules,
      prompts.publicPersona,
      `Context:\n${ctx.join("\n\n")}`,
    ].join("\n\n");

    if (wantsStream(c)) {
      return stream(c, async (s) => {
        for await (const delta of completeStream({ client, system, messages })) {
          await s.write(`data: ${JSON.stringify({ delta })}\n\n`);
        }
        await s.write("event: end\ndata: {}\n\n");
      });
    }

    const out = await completeOnce({ client, system, messages });
    return c.json({ reply: out.content });
  });

  return app;
}
