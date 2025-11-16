import type { Context } from "hono";
import { Hono } from "hono";
import { stream } from "hono/streaming";
import { completeOnce, completeStream } from "../core/llm";
import { createJWTMiddleware } from "../middleware/jwt";
import { createRateLimiter } from "../middleware/ratelimit";
import type { ServerDependencies } from "../types";

function wantsStream(c: Context) {
  const url = new URL(c.req.url);
  if (url.searchParams.get("stream") === "1") return true;
  const acc = c.req.header("accept") ?? "";
  return acc.includes("text/event-stream");
}

export function privateRoutes(deps: ServerDependencies) {
  const { client, store, config, prompts } = deps;
  const app = new Hono();

  // Create middleware instances from config
  const requirePrivateJWT = createJWTMiddleware(config);
  const { limitPrivate } = createRateLimiter(config);

  app.use("/api/private/*", requirePrivateJWT);
  app.use("/api/private/*", limitPrivate());

  app.post("/api/private/chat", async (c) => {
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

    const ctx = await store.query(lastUserMsg.content, 8, ["base", "private"]);
    const system = [
      prompts.baseSystemRules,
      prompts.privatePersona,
      `Internal Context:\n${ctx.join("\n\n")}`,
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
