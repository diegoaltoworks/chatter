import type { Context } from "hono";
import { Hono } from "hono";
import { stream } from "hono/streaming";
import { answerOnce, answerStream } from "../core/answer";
import { resolveBuckets } from "../core/buckets";
import { normalizeChatBody } from "../core/messages";
import { prepareChat } from "../core/pipeline";
import { createJWTMiddleware, jwtSubject } from "../middleware/jwt";
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

    // Accepts a single message or a conversation; client system/tool turns are
    // dropped so the server keeps sole ownership of the system prompt.
    const normalized = normalizeChatBody(body);
    if (!normalized.ok) {
      return c.json({ error: normalized.error }, 400);
    }
    const { messages } = normalized;

    // The verified JWT subject is this surface's sender identity.
    const sender = jwtSubject(c);
    const buckets = await resolveBuckets({
      mode: "private",
      sender,
      bucketsFor: config.bucketsFor,
    });

    let system: string;
    try {
      ({ system } = await prepareChat({ store, prompts, mode: "private", messages, buckets }));
    } catch {
      return c.json({ error: "no user message found in conversation" }, 400);
    }

    const model = config.openai.model;
    const answerFn = config.answerFn;

    if (wantsStream(c)) {
      return stream(c, async (s) => {
        for await (const delta of answerStream({
          answerFn,
          client,
          system,
          messages,
          mode: "private",
          sender,
          model,
        })) {
          await s.write(`data: ${JSON.stringify({ delta })}\n\n`);
        }
        await s.write("event: end\ndata: {}\n\n");
      });
    }

    const out = await answerOnce({
      answerFn,
      client,
      system,
      messages,
      mode: "private",
      sender,
      model,
    });
    return c.json({ reply: out.content });
  });

  return app;
}
