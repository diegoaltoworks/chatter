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
import { answerOnce, answerStream, applyTransformReply } from "../core/answer";
import { resolveBuckets } from "../core/buckets";
import { DEFAULT_MODEL } from "../core/llm";
import { normalizeMessages } from "../core/messages";
import { type PipelineMode, prepareChat } from "../core/pipeline";
import { API_KEY_HEADER } from "../middleware/apiKey";
import { chatBodyLimit } from "../middleware/bodyLimit";
import { createJWTMiddleware, jwtSubject } from "../middleware/jwt";
import { createRateLimiter } from "../middleware/ratelimit";
import type { ServerDependencies } from "../types";

/** The verified API key's id, attached by `requireApiKey` for the public route */
interface ContextWithApiKeySub extends Context {
  apiKeySub?: string;
}

function apiKeySubject(c: Context): string | undefined {
  const sub = (c as ContextWithApiKeySub).apiKeySub;
  return sub && sub.trim().length > 0 ? sub : undefined;
}

/**
 * `ServerDependencies.apiKeyManager` accepts any caller-supplied
 * implementation (`payload` is typed `unknown` there), so its `sub` is
 * narrowed defensively rather than trusted as `ApiKeyPayload`.
 */
function payloadSub(payload: unknown): string | undefined {
  const sub = (payload as { sub?: unknown } | undefined)?.sub;
  return typeof sub === "string" ? sub : undefined;
}

// Token-safe and header-safe: rejects CRLF/unicode that would throw setting
// the response header, and bounds length against a client trying to smuggle
// an oversized value into it. Invalid input is treated the same as absent —
// a fresh id is generated — rather than failing the request over a field
// that's otherwise opaque to the client.
const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,200}$/;

function sanitizeConversationId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && CONVERSATION_ID_PATTERN.test(trimmed) ? trimmed : undefined;
}

/** Client-suppliable conversation id: `x-conversation-id` header, else a `conversation_id` body field. */
function clientConversationId(c: Context, body: unknown): string | undefined {
  const header = sanitizeConversationId(c.req.header("x-conversation-id"));
  if (header) return header;
  const fromBody = (body as { conversation_id?: unknown })?.conversation_id;
  return sanitizeConversationId(typeof fromBody === "string" ? fromBody : undefined);
}

function errorJson(c: Context, status: 400 | 401, message: string) {
  return c.json(
    { error: { message, type: status === 401 ? "authentication_error" : "invalid_request_error" } },
    status,
  );
}

/** Matches `errorJson`'s `{ error: { message, type } }` shape for the 413 from `chatBodyLimit`. */
function oversizedBodyError(message: string) {
  return { error: { message, type: "invalid_request_error" } };
}

export function openaiRoutes(deps: ServerDependencies) {
  const { client, store, config, prompts, apiKeyManager, logger } = deps;
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
      : c.req.header(API_KEY_HEADER);
    if (!key) {
      return errorJson(
        c,
        401,
        `Missing API key (Authorization: Bearer or ${API_KEY_HEADER} header)`,
      );
    }
    try {
      const result = await apiKeyManager.verify(key);
      if (result.valid) {
        (c as ContextWithApiKeySub).apiKeySub = payloadSub(result.payload);
        return await next();
      }
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

    // Only the private route carries a per-user identity; the public one is
    // API-key gated, so it stays anonymous and is clamped accordingly. This
    // is the retrieval-scope identity — do not widen it with the API key
    // subject below, or the public route could reach private buckets.
    const buckets = await resolveBuckets({
      mode,
      sender: jwtSubject(c),
      bucketsFor: config.bucketsFor,
    });

    // Identity handed to the brain hook and rewriteQuery only — never used
    // for retrieval scope. The private route's JWT subject and the public
    // route's API key id are both "who is asking", just not "what may they
    // read": rewriteQuery doesn't widen access the way bucketsFor could, so
    // it sees the same broader identity answerFn does.
    const sender = jwtSubject(c) ?? apiKeySubject(c);

    let system: string;
    try {
      ({ system } = await prepareChat({
        store,
        prompts,
        mode,
        messages,
        buckets,
        sender,
        rewriteQuery: config.rewriteQuery,
        rerankContext: config.rerankContext,
        fallbackFn: config.fallbackFn,
        logger,
      }));
    } catch {
      return errorJson(c, 400, "Conversation must contain at least one user message");
    }

    // A brain hook can key threads/history off this; generated when the
    // client sends neither and echoed back via response header so the
    // client can correlate later turns.
    const conversationId = clientConversationId(c, body) ?? crypto.randomUUID();
    c.header("x-conversation-id", conversationId);

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
          sender,
          conversationId,
          temperature,
          model: serverModel,
          refusal: config.refusal,
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
      sender,
      conversationId,
      temperature,
      model: serverModel,
      refusal: config.refusal,
    });
    const reply = await applyTransformReply(
      config.transformReply,
      { channel: `openai-compat-${mode}`, sender, conversationId, text: out.content },
      logger,
    );
    return c.json({
      id,
      object: "chat.completion",
      created,
      model: serverModel,
      choices: [
        { index: 0, message: { role: "assistant", content: reply ?? "" }, finish_reason: "stop" },
      ],
      usage: out.usage,
    });
  };

  if (enablePublic) {
    app.use("/v1/*", chatBodyLimit(config.server?.maxRequestBytes, oversizedBodyError)); // Reject oversized bodies first
    app.use("/v1/*", requireApiKey);
    app.use("/v1/*", limitPublic());
    app.post("/v1/chat/completions", handleChatCompletions("public"));
  }

  if (enablePrivate) {
    app.use("/api/private/v1/*", chatBodyLimit(config.server?.maxRequestBytes, oversizedBodyError)); // Reject oversized bodies first
    app.use("/api/private/v1/*", requirePrivateJWT);
    app.use("/api/private/v1/*", limitPrivate());
    app.post("/api/private/v1/chat/completions", handleChatCompletions("private"));
  }

  return app;
}
