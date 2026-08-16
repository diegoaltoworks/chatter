/**
 * Telegram Bot API client — the whole transport layer of the Telegram
 * channel, over plain `fetch`. No SDK, no optional peer dependency: the Bot
 * API is JSON over HTTPS, so `./telegram` costs a consumer nothing beyond the
 * package itself.
 *
 * Everything here is about the wire: envelopes, error mapping, the 4096-char
 * message limit. Interpretation of a message (mentions, gates, replies) lives
 * in `./updates` and `./channel`.
 *
 * The bot token is a credential that appears in every request URL, so it is
 * never allowed into an error message or a log line — see {@link redactToken}.
 */

/** Default Bot API origin. A self-hosted Bot API server sets its own via `baseUrl`. */
export const TELEGRAM_API_BASE = "https://api.telegram.org";

/** Bot API `sendMessage` hard limit, in UTF-16 code units. A longer text is rejected with HTTP 400. */
export const TELEGRAM_TEXT_LIMIT = 4096;

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  username?: string;
  first_name?: string;
}

export interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
}

/** Offsets/lengths are UTF-16 code units — the same units JS string indexing uses, so `text.slice(offset, offset + length)` is exact. */
export interface TelegramMessageEntity {
  type: string;
  offset: number;
  length: number;
  /** Present on `text_mention` entities: a mention of a user who has no username. */
  user?: TelegramUser;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  text?: string;
  /** Photos/videos/documents carry their text here, with entities on `caption_entities`. */
  caption?: string;
  entities?: TelegramMessageEntity[];
  caption_entities?: TelegramMessageEntity[];
  reply_to_message?: { message_id?: number; from?: TelegramUser };
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

interface TelegramEnvelope<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

/** A Bot API call that did not return `ok: true`, or never completed. `retryAfterMs` carries Telegram's own flood-wait instruction when it sent one. */
export class TelegramApiError extends Error {
  readonly errorCode?: number;
  readonly retryAfterMs?: number;

  constructor(message: string, options?: { errorCode?: number; retryAfterMs?: number }) {
    super(message);
    this.name = "TelegramApiError";
    this.errorCode = options?.errorCode;
    this.retryAfterMs = options?.retryAfterMs;
  }
}

/**
 * Replaces every occurrence of the bot token with `***`. The token is part of
 * the request URL, and a fetch failure (or a proxy's error body) can echo that
 * URL back — logging it verbatim would leak full control of the bot into the
 * host's logs. An empty token is left alone: replacing "" would corrupt the
 * message rather than protect anything.
 */
export function redactToken(text: string, token: string): string {
  if (!token) return text;
  return text.split(token).join("***");
}

/**
 * Splits `text` into chunks no longer than `limit`, preferring paragraph, then
 * line, then word boundaries — a model's answer regularly runs past Telegram's
 * 4096-char cap, and the Bot API's response to that is to reject the whole
 * message, so an unsplit send loses the answer entirely rather than truncating
 * it. Empty/blank input yields no chunks (nothing to send).
 */
export function splitTelegramText(text: string, limit: number = TELEGRAM_TEXT_LIMIT): string[] {
  if (!text.trim()) return [];
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    // Break at the last boundary in the window; `lastIndexOf` on the window
    // (not the whole string) keeps every chunk within the limit by
    // construction. No boundary at all (one very long word) falls back to a
    // hard cut — better a split word than a dropped answer.
    const boundary = ["\n\n", "\n", " "]
      .map((separator) => window.lastIndexOf(separator))
      .find((index) => index > 0);
    const cut = boundary ?? limit;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/** What `ChannelSender.sendMedia` accepts for this channel. A bare string is shorthand for a photo URL. */
export interface TelegramMediaPayload {
  /** @default "photo" */
  kind?: "photo" | "document" | "video" | "audio";
  /** An https URL or a Telegram `file_id` — the two forms the Bot API accepts without a multipart upload. */
  url: string;
  caption?: string;
}

const MEDIA_METHODS = {
  photo: { method: "sendPhoto", field: "photo" },
  document: { method: "sendDocument", field: "document" },
  video: { method: "sendVideo", field: "video" },
  audio: { method: "sendAudio", field: "audio" },
} as const;

/**
 * Turns the registry's opaque `sendMedia` payload into a Bot API call.
 * `ChannelSender.sendMedia` types its payload as `unknown` (payload shapes are
 * transport-defined), so this is where that unknown is checked — a malformed
 * payload throws here, which the sender registry reports as `false` rather
 * than letting a caller's bad send crash it.
 */
export function toTelegramMediaRequest(
  chatId: string,
  payload: unknown,
): { method: string; body: Record<string, unknown> } {
  const media: TelegramMediaPayload =
    typeof payload === "string" ? { url: payload } : (payload as TelegramMediaPayload);
  if (!media || typeof media !== "object" || typeof media.url !== "string" || !media.url) {
    throw new TypeError(
      "Telegram sendMedia payload must be a URL string or { url, kind?, caption? } — got: " +
        typeof payload,
    );
  }
  const kind = media.kind ?? "photo";
  const target = MEDIA_METHODS[kind];
  if (!target) {
    throw new TypeError(
      `Telegram sendMedia kind must be one of ${Object.keys(MEDIA_METHODS).join(", ")} — got "${kind}"`,
    );
  }
  return {
    method: target.method,
    body: {
      chat_id: chatId,
      [target.field]: media.url,
      ...(media.caption ? { caption: media.caption } : {}),
    },
  };
}

export interface TelegramApiConfig {
  botToken: string;
  /** Overridable for tests and for hosts routing through a proxy; defaults to `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** @default {@link TELEGRAM_API_BASE} */
  baseUrl?: string;
}

export interface TelegramApi {
  /** Raw call, for a method this interface does not wrap. Rejects with {@link TelegramApiError} on any non-`ok` result. */
  call<T>(method: string, body?: Record<string, unknown>, signal?: AbortSignal): Promise<T>;
  getMe(): Promise<TelegramUser>;
  getUpdates(options: {
    offset?: number;
    timeoutSeconds: number;
    signal?: AbortSignal;
  }): Promise<TelegramUpdate[]>;
  /** Splits at {@link TELEGRAM_TEXT_LIMIT}; only the first chunk threads onto `replyToMessageId`. */
  sendMessage(chatId: string, text: string, options?: { replyToMessageId?: number }): Promise<void>;
  sendMedia(chatId: string, payload: unknown): Promise<void>;
  setMessageReaction(chatId: string, messageId: number, emoji: string): Promise<void>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createTelegramApi(config: TelegramApiConfig): TelegramApi {
  const token = config.botToken;
  if (!token.trim()) throw new Error("Telegram botToken is required (e.g. TELEGRAM_BOT_TOKEN)");
  const baseUrl = (config.baseUrl ?? TELEGRAM_API_BASE).replace(/\/+$/, "");
  const doFetch = config.fetch ?? globalThis.fetch;

  async function call<T>(
    method: string,
    body?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    let response: Response;
    try {
      response = await doFetch(`${baseUrl}/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
        signal,
      });
    } catch (error) {
      throw new TelegramApiError(
        `${method} request failed: ${redactToken(errorText(error), token)}`,
      );
    }

    let envelope: TelegramEnvelope<T> | undefined;
    try {
      envelope = (await response.json()) as TelegramEnvelope<T>;
    } catch {
      throw new TelegramApiError(
        `${method} returned a non-JSON response (HTTP ${response.status})`,
      );
    }

    if (!envelope?.ok) {
      const retryAfter = envelope?.parameters?.retry_after;
      throw new TelegramApiError(
        `${method} failed (HTTP ${response.status}): ${redactToken(envelope?.description ?? "unknown error", token)}`,
        {
          errorCode: envelope?.error_code,
          retryAfterMs: typeof retryAfter === "number" ? retryAfter * 1000 : undefined,
        },
      );
    }
    return envelope.result as T;
  }

  return {
    call,
    getMe: () => call<TelegramUser>("getMe"),
    getUpdates: ({ offset, timeoutSeconds, signal }) =>
      call<TelegramUpdate[]>(
        "getUpdates",
        {
          ...(offset === undefined ? {} : { offset }),
          timeout: timeoutSeconds,
          // Only what this channel interprets: asking for every update type
          // would have Telegram queue edits, reactions and channel posts this
          // channel then silently discards.
          allowed_updates: ["message"],
        },
        signal,
      ),
    async sendMessage(chatId, text, options) {
      const chunks = splitTelegramText(text);
      for (const [index, chunk] of chunks.entries()) {
        await call("sendMessage", {
          chat_id: chatId,
          text: chunk,
          // Threading belongs on the first chunk only — every chunk quoting
          // the same incoming message reads as several separate replies.
          ...(index === 0 && options?.replyToMessageId
            ? {
                reply_parameters: {
                  message_id: options.replyToMessageId,
                  // The quoted message can be gone by the time we answer
                  // (deleted, or an old message in a cleared chat); sending
                  // unthreaded beats failing the whole reply.
                  allow_sending_without_reply: true,
                },
              }
            : {}),
        });
      }
    },
    async sendMedia(chatId, payload) {
      const { method, body } = toTelegramMediaRequest(chatId, payload);
      await call(method, body);
    },
    async setMessageReaction(chatId, messageId, emoji) {
      await call("setMessageReaction", {
        chat_id: chatId,
        message_id: messageId,
        reaction: [{ type: "emoji", emoji }],
      });
    },
  };
}
