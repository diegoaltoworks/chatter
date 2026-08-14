/**
 * Image generation - public types.
 *
 * Framework-free: this file (and everything else in src/images/) must not import
 * from chatter's core, routes or channels. The module is self-contained and
 * carries no persona or bot-specific content - prompts arrive fully composed
 * from the caller.
 */

/** Every failure mode the module reports, so callers can pick a reply per case. */
export type ImageErrorCode = "not_configured" | "invalid_request" | "moderation" | "api_error";

/** Typed error - callers switch on `code`, never on message text. */
export class ImageGenerationError extends Error {
  readonly code: ImageErrorCode;

  constructor(code: ImageErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ImageGenerationError";
    this.code = code;
  }
}

/** Image bytes plus the MIME type they were encoded with. Defaults to PNG when omitted. */
export interface ImageInput {
  bytes: Uint8Array;
  mimeType?: string;
}

/**
 * A request for a generated image.
 *
 * `prompt` is fully composed by the caller - this module has no prompt
 * templates or character content of its own. `baseImage` and `inputImages`
 * are both optional: omit both for a pure text-to-image generate call, or
 * supply them to edit/composite against existing pictures.
 */
export interface ImageRequest {
  prompt: string;
  /** Image to edit. Omit for a pure generate call. */
  baseImage?: ImageInput;
  /** Additional reference photos, sent alongside `baseImage`. */
  inputImages?: ImageInput[];
}

/** A generated picture, ready to be uploaded or attached. */
export interface GeneratedImage {
  /** Raw PNG bytes. */
  imageBytes: Uint8Array;
  /** The same bytes, base64-encoded, as returned by the image API. */
  b64: string;
}

/**
 * The slice of the image API this module depends on.
 *
 * Declared structurally so tests can inject a mock and no real (paid) call is
 * ever made from the suite, and so the module does not hard-depend on one SDK
 * version.
 */
export interface ImageClient {
  createImage(params: ImageClientRequest): Promise<ImageClientResponse>;
}

export interface ImageClientRequest {
  model: string;
  prompt: string;
  size: string;
  quality: string;
  n: number;
  baseImage?: { bytes: Uint8Array; fileName: string; mimeType: string };
  inputImages?: Array<{ bytes: Uint8Array; fileName: string; mimeType: string }>;
}

export interface ImageClientResponse {
  data?: Array<{ b64_json?: string | null }> | null;
}

/**
 * The slice of the Cloudinary upload API this module depends on.
 *
 * Declared structurally, same reasoning as {@link ImageClient}: tests inject a
 * mock and no real (paid) upload is ever made from the suite.
 */
export interface CloudinaryUploadClient {
  upload(request: CloudinaryUploadRequest): Promise<CloudinaryUploadResponse>;
}

export interface CloudinaryUploadRequest {
  /** PNG bytes to upload. */
  imageBytes: Uint8Array;
  /** Deterministic id derived from the request - see `publicIdForRequest`. */
  publicId: string;
  folder: string;
}

export interface CloudinaryUploadResponse {
  secureUrl: string;
}
