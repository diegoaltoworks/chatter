/**
 * OpenAI-compatible chat completions routes.
 *
 * Exposes the RAG pipeline over the standard OpenAI wire format so any
 * off-the-shelf chat UI or SDK (deep-chat, assistant-ui, the official
 * OpenAI clients, Vercel AI SDK, ...) can talk to Chatter without a
 * bespoke adapter:
 *
 *   POST /v1/chat/completions              → public pipeline (API key)
 *   POST /api/private/v1/chat/completions  → private pipeline (JWT)
 *
 * Both support `stream: true` (SSE `chat.completion.chunk` events ending
 * with `data: [DONE]`) and non-streaming JSON responses.
 *
 * Hardening notes:
 *  - The upstream model is always the server-configured one; a client's
 *    `model` field is accepted for wire compatibility but never used to
 *    pick the upstream model (callers must not control spend).
 *  - Incoming `system`/`tool` messages are dropped: the system prompt is
 *    owned by the server (guardrails + persona + retrieved context).
 *  - The public route requires a real JWT API key via `Authorization:
 *    Bearer` or `x-api-key`; widget-only session/demo keys are not valid.
 */

import type { Context, Next } from "hono";
import { Hono } from "hono";
import { stream } from "hono/streaming";
import { answerOnce, answerStream } from "../core/answer";
import { DEFAULT_MODEL } from "../core/llm";
import { type PipelineMessage, type PipelineMode, prepareChat } from "../core/pipeline";
import { createJWTMiddleware } from "../middleware/jwt";
import { createRateLimiter } from "../middleware/ratelimit";
import type { ServerDependencies } from "../types";

/**
 * Normalize OpenAI-format messages to the pipeline format.
 * Accepts string content and text content-part arrays; drops system/tool
 * messages. Returns null when nothing usable remains.
 */
export function normalizeMessages(raw: unknown): PipelineMessage[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;

  const messages: PipelineMessage[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") return null;
    const { role, content } = entry as { role?: unknown; content?: unknown };
    if (role !== "user" && role !== "assistant") continue;

    let text: string | null = null;
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .filter(
          (part): part is { type: "text"; text: string } =>
            !!part &&
            typeof part === "object" &&
            (part as { type?: unknown }).type === "text" &&
            typeof (part as { text?: unknown }).text === "string",
        )
        .map((part) => part.text)
        .join("");
    }
    if (text === null) continue;

    messages.push({ role, content: text });
  }

  return messages.length > 0 ? messages : null;
}

function errorJson(c: Context, status: 400 | 401, message: string) {
  return c.json(
    { error: { message, type: status === 401 ? "authentication_error" : "invalid_request_error" } },
    status,
  );
}

export function openaiRoutes(deps: ServerDependencies) {
  const { client, store, config, prompts, apiKeyManager } = deps;
  const app = new Hono();

  const { limitPublic, limitPrivate } = createRateLimiter(config);
  const requirePrivateJWT = createJWTMiddleware(config);
  const enablePublic = config.features?.enablePublicChat !== false;
  const enablePrivate = config.features?.enablePrivateChat !== false;
  const serverModel = config.openai.model || DEFAULT_MODEL;

  /**
   * API-key auth for the public v1 route. Accepts the key from the
   * standard OpenAI `Authorization: Bearer` header or `x-api-key`.
   */
  async function requireApiKey(c: Context, next: Next) {
    if (!apiKeyManager) {
      return errorJson(c, 401, "API key authentication is not configured on this server");
    }
    const bearer = c.req.header("authorization") ?? "";
    const key = bearer.startsWith("Bearer ")
      ? bearer.slice("Bearer ".length)
      : c.req.header("x-api-key");
    if (!key) {
      return errorJson(c, 401, "Missing API key (Authorization: Bearer or x-api-key header)");
    }
    try {
      const result = await apiKeyManager.verify(key);
      if (result.valid) return await next();
    } catch {
      // fall through to the 401 below
    }
    return errorJson(c, 401, "Invalid API key");
  }

  const handleChatCompletions = (mode: PipelineMode) => async (c: Context) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return errorJson(c, 400, "Request body must be a JSON object");
    }

    const messages = normalizeMessages((body as { messages?: unknown }).messages);
    if (!messages) {
      return errorJson(c, 400, "'messages' must be a non-empty array of user/assistant messages");
    }

    const { stream: wantsStream, temperature: rawTemperature } = body as {
      stream?: unknown;
      temperature?: unknown;
    };
    const temperature =
      typeof rawTemperature === "number" && Number.isFinite(rawTemperature)
        ? Math.min(Math.max(rawTemperature, 0), 2)
        : undefined;

    let system: string;
    try {
      ({ system } = await prepareChat({ store, prompts, mode, messages }));
    } catch {
      return errorJson(c, 400, "Conversation must contain at least one user message");
    }

    const id = `chatcmpl-${crypto.randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);

    if (wantsStream === true) {
      c.header("Content-Type", "text/event-stream");
      c.header("Cache-Control", "no-cache");
      return stream(c, async (s) => {
        const chunk = (delta: Record<string, unknown>, finishReason: string | null) =>
          `data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created,
            model: serverModel,
            choices: [{ index: 0, delta, finish_reason: finishReason }],
          })}\n\n`;

        await s.write(chunk({ role: "assistant", content: "" }, null));
        for await (const delta of answerStream({
          answerFn: config.answerFn,
          client,
          system,
          messages,
          mode,
          temperature,
          model: serverModel,
        })) {
          await s.write(chunk({ content: delta }, null));
        }
        await s.write(chunk({}, "stop"));
        await s.write("data: [DONE]\n\n");
      });
    }

    const out = await answerOnce({
      answerFn: config.answerFn,
      client,
      system,
      messages,
      mode,
      temperature,
      model: serverModel,
    });
    return c.json({
      id,
      object: "chat.completion",
      created,
      model: serverModel,
      choices: [
        { index: 0, message: { role: "assistant", content: out.content }, finish_reason: "stop" },
      ],
      usage: out.usage,
    });
  };

  if (enablePublic) {
    app.use("/v1/*", requireApiKey);
    app.use("/v1/*", limitPublic());
    app.post("/v1/chat/completions", handleChatCompletions("public"));
  }

  if (enablePrivate) {
    app.use("/api/private/v1/*", requirePrivateJWT);
    app.use("/api/private/v1/*", limitPrivate());
    app.post("/api/private/v1/chat/completions", handleChatCompletions("private"));
  }

  return app;
}
