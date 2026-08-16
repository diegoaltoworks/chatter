/**
 * Matrix Client-Server API client — the whole transport layer of the Matrix
 * channel, over plain `fetch`. No SDK, no optional peer dependency: the
 * client-server API is JSON over HTTPS (plus one raw-bytes upload endpoint),
 * so `./matrix` costs a consumer nothing beyond the package itself.
 *
 * Everything here is about the wire: envelopes, error mapping, sync polling,
 * sending, media upload. Interpretation of a room event (mentions, DMs,
 * reply-to) lives in `./updates` and `./channel`.
 *
 * The access token is a credential carried in an `Authorization: Bearer`
 * header, never a query string, so it never lands in a URL an error message
 * might echo back — but a homeserver's own error body could still quote it
 * back verbatim (a malformed-token 401, say), so it is redacted the same
 * defensive way the Telegram client redacts its token — see
 * {@link redactToken}.
 */

export interface MatrixEvent {
  type: string;
  event_id: string;
  sender: string;
  origin_server_ts: number;
  content: Record<string, unknown>;
  unsigned?: Record<string, unknown>;
}

export interface MatrixRoomTimeline {
  events: MatrixEvent[];
  /**
   * True when the server omitted earlier events for size — a bot only ever
   * reads forward from its own `since` token, so a limited timeline just
   * means "more happened than fit in this batch", not a gap it needs to
   * backfill; every event actually included here is still handled normally.
   */
  limited?: boolean;
  prev_batch?: string;
}

export interface MatrixJoinedRoom {
  timeline: MatrixRoomTimeline;
}

/**
 * A state event as it arrives in an invite's `invite_state`: the homeserver
 * strips it down to type/state_key/sender/content for a room the bot has not
 * joined, so there is no `event_id` or `origin_server_ts` here the way there
 * is on a timeline event.
 */
export interface MatrixStrippedStateEvent {
  type: string;
  state_key?: string;
  sender?: string;
  content?: Record<string, unknown>;
}

export interface MatrixInvitedRoom {
  invite_state?: { events: MatrixStrippedStateEvent[] };
}

export interface MatrixAccountDataEvent {
  type: string;
  content: Record<string, unknown>;
}

export interface MatrixSyncResponse {
  next_batch: string;
  rooms?: {
    join?: Record<string, MatrixJoinedRoom>;
    invite?: Record<string, MatrixInvitedRoom>;
  };
  account_data?: { events?: MatrixAccountDataEvent[] };
}

interface MatrixErrorBody {
  errcode?: string;
  error?: string;
  retry_after_ms?: number;
}

/** A client-server API call that returned a non-2xx, or never completed. `retryAfterMs` carries `M_LIMIT_EXCEEDED`'s own wait instruction when the homeserver sent one. */
export class MatrixApiError extends Error {
  readonly errcode?: string;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    options?: { errcode?: string; status?: number; retryAfterMs?: number },
  ) {
    super(message);
    this.name = "MatrixApiError";
    this.errcode = options?.errcode;
    this.status = options?.status;
    this.retryAfterMs = options?.retryAfterMs;
  }
}

/**
 * Replaces every occurrence of `token` with `***`. An empty token is left
 * alone: replacing "" would corrupt the message rather than protect
 * anything.
 */
export function redactToken(text: string, token: string): string {
  if (!token) return text;
  return text.split(token).join("***");
}

export type MatrixMediaKind = "image" | "file" | "video" | "audio";

/** What `ChannelSender.sendMedia` accepts for this channel. A bare string is shorthand for an already-uploaded `mxc://` URI or an https URL to fetch and re-upload. */
export interface MatrixMediaPayload {
  /** @default "image" */
  kind?: MatrixMediaKind;
  /** An `mxc://` content URI (sent as-is) or an https URL (fetched under {@link MatrixApiConfig.maxMediaBytes}, then uploaded). Any other scheme is rejected. */
  url: string;
  caption?: string;
  /** @default derived from the URL's last path segment, or the media kind */
  filename?: string;
}

/**
 * Default ceiling on a fetched media source. `sendMedia` is reachable from a
 * scheduler, a flow or an `answerFn` tool call, so its URL is not necessarily
 * one an operator chose: an unbounded fetch would let whatever produced that
 * URL decide how much memory this process allocates.
 */
export const DEFAULT_MAX_MEDIA_BYTES = 25 * 1024 * 1024;

const MEDIA_MSGTYPE: Record<MatrixMediaKind, string> = {
  image: "m.image",
  file: "m.file",
  video: "m.video",
  audio: "m.audio",
};

export interface MatrixApiConfig {
  /** Homeserver client-server API origin, e.g. `https://matrix.example.org`. */
  homeserverUrl: string;
  /** A logged-in bot user's access token. A credential — pass it from the environment, never commit it. */
  accessToken: string;
  /** Overridable for tests and for hosts routing through a proxy; defaults to `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** Cap on the bytes `sendMedia` will pull from a remote https URL before uploading. @default 25 MiB */
  maxMediaBytes?: number;
}

export interface MatrixApi {
  /** Raw call, for an endpoint this interface does not wrap. Rejects with {@link MatrixApiError} on any non-2xx response. */
  call<T>(
    method: string,
    path: string,
    options?: {
      body?: unknown;
      query?: Record<string, string | number | undefined>;
      signal?: AbortSignal;
    },
  ): Promise<T>;
  whoami(): Promise<{ userId: string }>;
  sync(options: {
    since?: string;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<MatrixSyncResponse>;
  /** A user's global account data of `type` (e.g. `m.direct`), or `undefined` if it was never set (`M_NOT_FOUND`). */
  getAccountData<T>(userId: string, type: string): Promise<T | undefined>;
  /** Replaces a user's global account data of `type`. Whole-document semantics: the homeserver stores exactly what is sent, so merge before calling. */
  setAccountData(userId: string, type: string, content: Record<string, unknown>): Promise<void>;
  /** Sends an `m.room.message` (or any event type, via `eventType`) and returns its event id. */
  sendEvent(
    roomId: string,
    content: Record<string, unknown>,
    options?: { eventType?: string },
  ): Promise<{ eventId: string }>;
  /** Uploads raw bytes to the media repository and returns its `mxc://` content URI. */
  uploadMedia(
    bytes: Uint8Array,
    contentType: string,
    filename?: string,
  ): Promise<{ contentUri: string }>;
  /** Fetches `url`, uploads the bytes, and sends the resulting `m.room.message` — the whole `MatrixMediaPayload` -> delivered-event path. */
  sendMedia(roomId: string, payload: unknown): Promise<{ eventId: string }>;
  joinRoom(roomIdOrAlias: string): Promise<void>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

let txnCounter = 0;
/** A transaction id unique within this process — the client-server API requires one per `send` call so a retried request is idempotent. */
function nextTxnId(): string {
  txnCounter += 1;
  return `chatter-${Date.now()}-${txnCounter}`;
}

function toMediaRequest(payload: unknown): {
  kind: MatrixMediaKind;
  url: string;
  caption?: string;
  filename?: string;
} {
  const media: MatrixMediaPayload =
    typeof payload === "string" ? { url: payload } : (payload as MatrixMediaPayload);
  if (!media || typeof media !== "object" || typeof media.url !== "string" || !media.url) {
    throw new TypeError(
      `Matrix sendMedia payload must be a URL/mxc string or { url, kind?, caption?, filename? } — got: ${typeof payload}`,
    );
  }
  const kind = media.kind ?? "image";
  if (!MEDIA_MSGTYPE[kind]) {
    throw new TypeError(
      `Matrix sendMedia kind must be one of ${Object.keys(MEDIA_MSGTYPE).join(", ")} — got "${kind}"`,
    );
  }
  return { kind, url: media.url, caption: media.caption, filename: media.filename };
}

/**
 * Rejects anything but `https:` for a URL this process is about to fetch on
 * the homeserver's behalf. `http:` would carry the bytes (and the redirect
 * chain) in the clear, and `file:`/`data:`/`blob:` would turn a media send
 * into a read of whatever the host process can reach locally. The URL is
 * still an outbound request from this process, so point it at content you
 * control.
 */
function assertHttpsMediaUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new TypeError(
      `Matrix sendMedia url must be an mxc:// URI or an https URL - could not parse "${url}"`,
    );
  }
  if (parsed.protocol !== "https:") {
    throw new TypeError(
      `Matrix sendMedia url must be an mxc:// URI or an https URL - got "${parsed.protocol}"`,
    );
  }
}

/**
 * Reads a response body, refusing to buffer more than `maxBytes`. A declared
 * `content-length` over the cap is rejected before a single byte is read; a
 * missing or lying one is caught by the running total, so a chunked response
 * cannot stream past the cap either.
 */
async function readCappedBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`media source declares ${declared} bytes, over the ${maxBytes} byte cap`);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      throw new Error(`media source is ${bytes.byteLength} bytes, over the ${maxBytes} byte cap`);
    }
    return bytes;
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`media source exceeds the ${maxBytes} byte cap`);
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function createMatrixApi(config: MatrixApiConfig): MatrixApi {
  const token = config.accessToken;
  if (!token.trim()) throw new Error("Matrix accessToken is required (e.g. MATRIX_ACCESS_TOKEN)");
  const homeserverUrl = config.homeserverUrl.trim().replace(/\/+$/, "");
  if (!homeserverUrl)
    throw new Error("Matrix homeserverUrl is required (e.g. https://matrix.example.org)");
  const doFetch = config.fetch ?? globalThis.fetch;
  const maxMediaBytes = config.maxMediaBytes ?? DEFAULT_MAX_MEDIA_BYTES;

  async function call<T>(
    method: string,
    path: string,
    options?: {
      body?: unknown;
      query?: Record<string, string | number | undefined>;
      signal?: AbortSignal;
    },
  ): Promise<T> {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(options?.query ?? {})) {
      if (value !== undefined) search.set(key, String(value));
    }
    const qs = search.toString();
    const url = `${homeserverUrl}${path}${qs ? `?${qs}` : ""}`;

    let response: Response;
    try {
      response = await doFetch(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(options?.body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: options?.signal,
      });
    } catch (error) {
      throw new MatrixApiError(
        `${method} ${path} request failed: ${redactToken(errorText(error), token)}`,
      );
    }

    if (response.ok) {
      if (response.status === 204) return undefined as T;
      try {
        return (await response.json()) as T;
      } catch {
        throw new MatrixApiError(
          `${method} ${path} returned a non-JSON response (HTTP ${response.status})`,
        );
      }
    }

    let body: MatrixErrorBody | undefined;
    try {
      body = (await response.json()) as MatrixErrorBody;
    } catch {
      // Not every error response is JSON (a proxy 502, say) — fall through with just the status.
    }
    throw new MatrixApiError(
      `${method} ${path} failed (HTTP ${response.status}): ${redactToken(body?.error ?? "unknown error", token)}`,
      { errcode: body?.errcode, status: response.status, retryAfterMs: body?.retry_after_ms },
    );
  }

  async function sendEvent(
    roomId: string,
    content: Record<string, unknown>,
    options?: { eventType?: string },
  ): Promise<{ eventId: string }> {
    const eventType = options?.eventType ?? "m.room.message";
    const result = await call<{ event_id: string }>(
      "PUT",
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/${encodeURIComponent(eventType)}/${nextTxnId()}`,
      { body: content },
    );
    return { eventId: result.event_id };
  }

  async function uploadMedia(
    bytes: Uint8Array,
    contentType: string,
    filename?: string,
  ): Promise<{ contentUri: string }> {
    const search = new URLSearchParams();
    if (filename) search.set("filename", filename);
    const qs = search.toString();
    let response: Response;
    try {
      response = await doFetch(`${homeserverUrl}/_matrix/media/v3/upload${qs ? `?${qs}` : ""}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": contentType },
        // Uint8Array is a valid fetch BodyInit at runtime (Bun/Node both
        // accept it); only the DOM lib's stricter overload set rejects it.
        body: bytes as BodyInit,
      });
    } catch (error) {
      throw new MatrixApiError(`media upload failed: ${redactToken(errorText(error), token)}`);
    }
    if (!response.ok) {
      let body: MatrixErrorBody | undefined;
      try {
        body = (await response.json()) as MatrixErrorBody;
      } catch {
        // best-effort — see call()'s identical fallback
      }
      throw new MatrixApiError(
        `media upload failed (HTTP ${response.status}): ${redactToken(body?.error ?? "unknown error", token)}`,
        { errcode: body?.errcode, status: response.status },
      );
    }
    let result: { content_uri: string };
    try {
      result = (await response.json()) as { content_uri: string };
    } catch {
      throw new MatrixApiError(
        `media upload returned a non-JSON response (HTTP ${response.status})`,
      );
    }
    return { contentUri: result.content_uri };
  }

  async function sendMedia(roomId: string, payload: unknown): Promise<{ eventId: string }> {
    const media = toMediaRequest(payload);
    let contentUri = media.url;
    if (!contentUri.startsWith("mxc://")) {
      // Outside the try: a bad scheme is a caller mistake, and a TypeError is
      // what the sender registry turns into a `false` rather than a thrown
      // MatrixApiError about the network.
      assertHttpsMediaUrl(media.url);
      let bytes: Uint8Array;
      let contentType = "application/octet-stream";
      try {
        const fetched = await doFetch(media.url);
        if (!fetched.ok) throw new Error(`fetching media source returned HTTP ${fetched.status}`);
        contentType = fetched.headers.get("content-type") ?? contentType;
        bytes = await readCappedBytes(fetched, maxMediaBytes);
      } catch (error) {
        throw new MatrixApiError(`could not fetch media source for upload: ${errorText(error)}`);
      }
      const filename = media.filename ?? media.url.split("/").pop() ?? media.kind;
      const uploaded = await uploadMedia(bytes, contentType, filename);
      contentUri = uploaded.contentUri;
    }
    return sendEvent(roomId, {
      msgtype: MEDIA_MSGTYPE[media.kind],
      body: media.caption ?? media.filename ?? media.kind,
      url: contentUri,
    });
  }

  return {
    call,
    async whoami() {
      const result = await call<{ user_id: string }>("GET", "/_matrix/client/v3/account/whoami");
      return { userId: result.user_id };
    },
    sync: ({ since, timeoutMs, signal }) =>
      call<MatrixSyncResponse>("GET", "/_matrix/client/v3/sync", {
        query: {
          since,
          timeout: timeoutMs,
          // An initial sync (no `since`) returns each joined room's recent
          // timeline by default — replaying it into the pipeline would
          // re-answer messages that arrived before this process ever
          // started. A bot only wants live traffic, so it asks for none:
          // room state (needed for auto-join / m.direct bookkeeping) still
          // comes through unaffected, only `timeline.events` is suppressed.
          ...(since ? {} : { filter: JSON.stringify({ room: { timeline: { limit: 0 } } }) }),
        },
        signal,
      }),
    sendEvent,
    uploadMedia,
    sendMedia,
    async joinRoom(roomIdOrAlias) {
      await call("POST", `/_matrix/client/v3/join/${encodeURIComponent(roomIdOrAlias)}`, {
        body: {},
      });
    },
    async getAccountData<T>(userId: string, type: string): Promise<T | undefined> {
      try {
        return await call<T>(
          "GET",
          `/_matrix/client/v3/user/${encodeURIComponent(userId)}/account_data/${encodeURIComponent(type)}`,
        );
      } catch (error) {
        if (error instanceof MatrixApiError && error.errcode === "M_NOT_FOUND") return undefined;
        throw error;
      }
    },
    async setAccountData(userId, type, content) {
      await call(
        "PUT",
        `/_matrix/client/v3/user/${encodeURIComponent(userId)}/account_data/${encodeURIComponent(type)}`,
        { body: content },
      );
    },
  };
}
