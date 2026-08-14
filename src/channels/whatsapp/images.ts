/**
 * Optional image requests in the WhatsApp channel: detect a drawing/picture
 * request (with or without an attached photo), route it through `../../images`,
 * and reply with the generated picture. Inert unless `./images` is
 * configured — `createWhatsAppImageHandler` returns `false` for every
 * message when it isn't, so callers fall through to normal chat.
 *
 * This module ships no bot personality: the detector and subject-cleaning
 * patterns are generic drawing verbs (no hardcoded bot names), and every
 * reply string (ack/limit/moderation/error) is caller-configured with no
 * default text.
 *
 * Downloading the attached photo needs Baileys' `downloadMediaMessage`,
 * which — per this subpath's rule that only `./baileys` touches the
 * optional peer dependency at runtime — is injected as `downloadPhoto`
 * rather than imported here. The host wires it via `./whatsapp`'s
 * `loadBaileys` (see docs/channels.md), not this module.
 *
 * Everything pulled in from `../../images` is type-only: each subpath is
 * built as its own bundle, so a value import here (even just for an
 * `instanceof` check) would inline the whole `./images` module — OpenAI SDK
 * included — into `./whatsapp`, and importing from the `../../images`
 * barrel rather than its leaf files pulls in every sibling module's value
 * imports too. Error mapping below checks `code`/`name` structurally
 * instead, which also means it works when the error crossed a bundle
 * boundary (the two subpaths' `ImageGenerationError` classes are not
 * `instanceof`-compatible with each other).
 */

import type { WAMessage, WASocket } from "@whiskeysockets/baileys";
import type { CaptionComposer } from "../../images/captionComposer";
import type { ImageInput, ImageRequest } from "../../images/types";
import type { ImageUploader } from "../../images/uploader";

// Verbs alone (draw/paint/sketch/illustrate) are a strong signal; bare nouns
// (picture/image/photo) are not — "nice photo!" or "what's in this photo?"
// would otherwise misfire into a paid generation. A noun only counts
// alongside an explicit request verb (make/generate/create) nearby.
const DEFAULT_DETECT_PATTERN =
  /\b(draw|paint|sketch|illustrate)\b|\b(make|generate|create)\b[^.!?]{0,20}\b(picture|image|drawing|photo|cartoon)\b/i;

const DEFAULT_STRIP_PATTERNS: readonly RegExp[] = [
  /@\d+/g,
  /^(hey|hi|please|ok)[,!\s]+/i,
  /^(can|could|will)\s+you\s+/i,
  // Longest-alternative-first ((an|a), not (a|an)): a first-match-wins
  // alternation would otherwise take "a" out of "an" and leave a stray "n".
  /^(please\s+)?(draw|paint|sketch|illustrate|make|generate|create)\s+(me|us)?\s*(an|a)?\s*(picture|image|drawing|sketch|photo|cartoon)?\s*(of\s+)?/i,
];

export interface DrawRequestDetectorConfig {
  /** Tested against the raw message text to decide whether it's an image request. Defaults to a generic set of drawing verbs — no bot-specific names. */
  detectPattern?: RegExp;
  /** Applied in order to derive the subject from the raw text (mention tokens, greetings/politeness, the draw verb itself). */
  stripPatterns?: readonly RegExp[];
}

/** Tests `text` against `pattern` without a caller-reused `g`/`y` regex's `lastIndex` carrying state between messages (which would otherwise make it match every other call). */
function testPattern(pattern: RegExp, text: string): boolean {
  return new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, "")).test(text);
}

export function isDrawRequest(text: string, config: DrawRequestDetectorConfig = {}): boolean {
  return testPattern(config.detectPattern ?? DEFAULT_DETECT_PATTERN, text);
}

/** Cleans a draw request into a scene subject: "@1234 please draw me a cat" -> "cat". Falls back to the trimmed original when the patterns strip everything (or nothing). */
export function drawSubject(text: string, config: DrawRequestDetectorConfig = {}): string {
  let subject = text;
  for (const pattern of config.stripPatterns ?? DEFAULT_STRIP_PATTERNS) {
    // Each pattern is applied to already-trimmed text, not the raw
    // accumulator: every default pattern is anchored (`^`), so a leftover
    // leading space from the previous strip (e.g. after removing a mention
    // token) would stop the next one from matching at all.
    subject = subject.replace(pattern, " ").replace(/\s+/g, " ").trim();
  }
  return subject.length > 0 ? subject : text.trim();
}

/** Neutral, overridable reply strings — this module ships no bot personality. Unset = silent for that outcome. */
export interface WhatsAppImageStrings {
  /** Sent immediately on accepting the request, before generation starts. */
  ack?: string;
  /** Sent when the per-sender/day cap (`checkAndReserve`) blocks the request. */
  limitReached?: string;
  /** Sent when the image API blocks the request on moderation grounds. */
  moderationBlocked?: string;
  /** Sent for any other generation/upload/download failure. */
  error?: string;
}

export interface WhatsAppImageHandlerDeps {
  /** The slice of `./images`' `ImageUploader` this module needs. */
  images: Pick<ImageUploader, "isConfigured" | "peekCached" | "getOrCreateImage">;
  /**
   * Per-sender/day reservation (e.g. `./usage`'s `DailyLimiter.checkAndReserve`).
   * Omit to skip the cap entirely. Checked AFTER the cache, so a cache hit
   * never burns a unit.
   */
  checkAndReserve?: (senderId: string) => Promise<{ allowed: boolean }>;
  /**
   * Downloads the attached photo as bytes. Omit to ignore attached photos —
   * text-only requests still work. See the module docstring for why this is
   * injected rather than imported.
   */
  downloadPhoto?: (message: WAMessage) => Promise<Uint8Array>;
  /** Best-effort tailored caption for the reply. Omit to send the image with no caption. */
  captionComposer?: Pick<CaptionComposer, "composeCaption">;
  detector?: DrawRequestDetectorConfig;
  strings?: WhatsAppImageStrings;
}

export interface WhatsAppImageRequestContext {
  sock: WASocket;
  message: WAMessage;
  chatId: string;
  senderId: string;
  text: string;
  hasPhoto: boolean;
}

/** `true` = the message was an image request and this module replied to it (successfully or with a mapped error) — the caller must not also route it through normal chat. `false` = not an image request, or `./images` isn't configured. */
export type WhatsAppImageHandler = (ctx: WhatsAppImageRequestContext) => Promise<boolean>;

/** Structural check, not `instanceof` — `ImageGenerationError` crosses a bundle boundary (this module never imports `./images`' class, see the module docstring), so `name`/`code` is the only bundle-safe way to recognise one. */
function isModerationError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "ImageGenerationError" &&
    (error as { code?: unknown }).code === "moderation"
  );
}

async function replyText(
  sock: WASocket,
  chatId: string,
  message: WAMessage,
  text: string | undefined,
): Promise<void> {
  if (!text) return;
  await sock.sendMessage(chatId, { text }, { quoted: message }).catch(() => undefined);
}

export function createWhatsAppImageHandler(deps: WhatsAppImageHandlerDeps): WhatsAppImageHandler {
  return async function handleWhatsAppImageRequest(
    ctx: WhatsAppImageRequestContext,
  ): Promise<boolean> {
    if (!deps.images.isConfigured()) return false;
    if (!isDrawRequest(ctx.text, deps.detector)) return false;

    const subject = drawSubject(ctx.text, deps.detector);

    try {
      const photoBytes = ctx.hasPhoto ? await deps.downloadPhoto?.(ctx.message) : undefined;
      const inputImages: ImageInput[] | undefined = photoBytes
        ? [{ bytes: photoBytes }]
        : undefined;
      const request: ImageRequest = { prompt: subject, inputImages };

      if (deps.checkAndReserve) {
        const cached = await deps.images.peekCached(request);
        if (!cached) {
          const reserved = await deps.checkAndReserve(ctx.senderId);
          if (!reserved.allowed) {
            await replyText(ctx.sock, ctx.chatId, ctx.message, deps.strings?.limitReached);
            return true;
          }
        }
      }

      await replyText(ctx.sock, ctx.chatId, ctx.message, deps.strings?.ack);

      const image = await deps.images.getOrCreateImage(request);
      const caption = deps.captionComposer
        ? await deps.captionComposer.composeCaption({ subject })
        : undefined;
      await ctx.sock.sendMessage(
        ctx.chatId,
        caption ? { image: { url: image.url }, caption } : { image: { url: image.url } },
        { quoted: ctx.message },
      );
    } catch (error) {
      const text = isModerationError(error) ? deps.strings?.moderationBlocked : deps.strings?.error;
      await replyText(ctx.sock, ctx.chatId, ctx.message, text);
    }
    return true;
  };
}
