/**
 * Inbound chat message normalization — the trust boundary for conversations.
 *
 * Every HTTP chat surface accepts a caller-supplied conversation, and the
 * server owns the system prompt (guardrails + persona + retrieved context).
 * Nothing a client sends may add to, or masquerade as, that prompt, so the
 * only roles that survive normalization are `user` and `assistant`:
 * `system`, `developer` and `tool` messages are dropped, not forwarded.
 *
 * Content is reduced to a plain string: strings pass through and OpenAI-style
 * content-part arrays are flattened to their text parts. Anything else (image
 * parts, tool calls, objects, numbers) carries no usable text and is skipped.
 */

import type { PipelineMessage } from "./pipeline";

/**
 * Roles a client is allowed to contribute to a conversation. The predicate
 * narrows to the pipeline's own role union, so this list cannot drift wider
 * than what the pipeline accepts without a type error.
 */
function isClientRole(role: unknown): role is PipelineMessage["role"] {
  return role === "user" || role === "assistant";
}

/**
 * Normalize a raw `messages` array to the pipeline format.
 *
 * Returns `null` when the input is not a non-empty array, when any entry is
 * not an object, or when nothing usable remains after filtering.
 */
export function normalizeMessages(raw: unknown): PipelineMessage[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;

  const messages: PipelineMessage[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") return null;
    const { role, content } = entry as { role?: unknown; content?: unknown };
    if (!isClientRole(role)) continue;

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

/** Outcome of normalizing a widget chat request body. */
export type NormalizedChatBody =
  | { ok: true; messages: PipelineMessage[] }
  | { ok: false; error: string };

/**
 * Normalize the widget chat body shape, which accepts either a single
 * `message` string or a `messages` conversation array.
 *
 * The resulting messages have been through `normalizeMessages`, so a client
 * cannot inject a system turn on these surfaces either.
 */
export function normalizeChatBody(body: unknown): NormalizedChatBody {
  const source =
    body && typeof body === "object" ? (body as { message?: unknown; messages?: unknown }) : {};

  if (Array.isArray(source.messages)) {
    if (source.messages.length === 0) {
      return { ok: false, error: "messages array cannot be empty" };
    }
    const messages = normalizeMessages(source.messages);
    if (!messages) {
      return {
        ok: false,
        error: "messages must contain user/assistant messages with text content",
      };
    }
    return { ok: true, messages };
  }

  // Single-message form: primitives are stringified as they always were;
  // objects and arrays are not (they stringify to noise, never to text the
  // pipeline could use).
  const { message } = source;
  if (message && typeof message !== "object") {
    return { ok: true, messages: [{ role: "user", content: String(message) }] };
  }

  return { ok: false, error: "either 'message' or 'messages' required" };
}
