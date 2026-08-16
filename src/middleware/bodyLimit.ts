import type { Context } from "hono";
import { bodyLimit as honoBodyLimit } from "hono/body-limit";

/** Generous for chat text, small enough to bound worst-case parse/memory cost. */
export const DEFAULT_MAX_REQUEST_BYTES = 262_144; // 256 KiB

/**
 * Rejects oversized chat request bodies before they reach JSON parsing.
 * Wraps Hono's `bodyLimit` so the 413 body matches the caller's error shape
 * instead of the plain-text 413 Hono sends by default. `toError` defaults to
 * this API's usual `{ error }` shape; the OpenAI-compatible routes pass
 * their own `{ error: { message, type } }` formatter.
 */
export function chatBodyLimit(
  maxSize: number = DEFAULT_MAX_REQUEST_BYTES,
  toError: (message: string) => unknown = (message) => ({ error: message }),
) {
  return honoBodyLimit({
    maxSize,
    onError: (c: Context) => c.json(toError("Request body too large"), 413),
  });
}
