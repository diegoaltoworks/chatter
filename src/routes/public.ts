import type { Context } from "hono";
import { Hono } from "hono";
import { stream } from "hono/streaming";
import { answerOnce, answerStream, applyTransformReply } from "../core/answer";
import { resolveBuckets } from "../core/buckets";
import { normalizeChatBody } from "../core/messages";
import { prepareChat } from "../core/pipeline";
import { createAuthMiddleware } from "../middleware/auth";
import { chatBodyLimit } from "../middleware/bodyLimit";
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
  const { client, store, config, prompts, logger } = deps;
  const app = new Hono();

  // Create middleware instances from deps
  const requirePublicKey = createAuthMiddleware(deps);
  const { limitPublic } = createRateLimiter(config);

  // Build the referrer allowlist from configured origins.
  // Falls back to publicUrl + localhost defaults when no origins are specified.
  const referrerOrigins = config.server?.allowedOrigins?.length
    ? config.server.allowedOrigins.filter((o) => o !== "*")
    : [config.bot.publicUrl, "http://localhost:8181", "http://127.0.0.1:8181"];

  // Security middleware stack
  app.use("/api/public/*", chatBodyLimit(config.server?.maxRequestBytes)); // Reject oversized bodies first
  app.use("/api/public/*", validateSessionKey(logger)); // Validate session keys first
  app.use("/api/public/*", requirePublicKey); // Then check API key
  // Referrer checking for demo keys
  app.use(
    "/api/public/*",
    requireReferrer(referrerOrigins, config.rateLimit?.demoApiKeys ?? [], logger),
  );
  app.use("/api/public/*", limitPublic()); // Rate limiting (stricter for demo keys)

  app.post("/api/public/chat", async (c) => {
    const body = await c.req.json().catch(() => ({}));

    // Accepts a single message or a conversation; client system/tool turns are
    // dropped so the server keeps sole ownership of the system prompt.
    const normalized = normalizeChatBody(body);
    if (!normalized.ok) {
      return c.json({ error: normalized.error }, 400);
    }
    const { messages } = normalized;

    // Anonymous surface: no sender identity, so `resolveBuckets` will not let
    // the hook reach past the public defaults.
    const buckets = await resolveBuckets({ mode: "public", bucketsFor: config.bucketsFor });

    let system: string;
    try {
      ({ system } = await prepareChat({ store, prompts, mode: "public", messages, buckets }));
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
          mode: "public",
          model,
        })) {
          await s.write(`data: ${JSON.stringify({ delta })}\n\n`);
        }
        await s.write("event: end\ndata: {}\n\n");
      });
    }

    const out = await answerOnce({ answerFn, client, system, messages, mode: "public", model });
    const reply = await applyTransformReply(
      config.transformReply,
      { channel: "widget-public", text: out.content },
      logger,
    );
    return c.json({ reply: reply ?? "" });
  });

  return app;
}
