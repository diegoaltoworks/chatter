/**
 * Image generation module - public entry point.
 *
 * `src/images/` is a self-contained, framework-free module: nothing here
 * imports from chatter's core, routes or channels, so it can be lifted
 * upstream as-is. Prompt composition, caption content and spend limits are
 * all the caller's job - this module ships no persona or bot content of its
 * own, and composes with `../usage` for daily spend limits rather than
 * reimplementing one.
 *
 * Published as the `@diegoaltoworks/chatter/images` subpath so the core
 * install stays untouched by it.
 *
 * @packageDocumentation
 */

export type { ImageCacheEntry, ImageCacheStore } from "./cache";
export {
  CACHE_TTL_MS,
  isCacheEntryFresh,
  publicIdForRequest,
} from "./cache";
export { createTursoImageCacheStore } from "./cacheStore";
export type {
  CaptionComposeFn,
  CaptionComposer,
  CaptionComposerOptions,
  CaptionRequest,
} from "./captionComposer";
export { createCaptionComposer } from "./captionComposer";
export { createCloudinaryUploadClient } from "./cloudinaryClient";
export type { CloudinaryEnv, CloudinaryModuleConfig } from "./cloudinaryConfig";
export {
  DEFAULT_CLOUDINARY_FOLDER,
  isCloudinaryConfigured,
  resolveCloudinaryConfig,
} from "./cloudinaryConfig";
export { signCloudinaryParams } from "./cloudinarySignature";
export type { ImageEnv, ImageModuleConfig } from "./config";
export {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_IMAGE_QUALITY,
  DEFAULT_IMAGE_SIZE,
  isImageConfigured,
  resolveImageConfig,
} from "./config";
export type { ImageGenerator, ImageGeneratorDeps } from "./generator";
export { createImageGenerator } from "./generator";
export { createOpenAIImageClient } from "./openaiClient";
export type {
  CloudinaryUploadClient,
  CloudinaryUploadRequest,
  CloudinaryUploadResponse,
  GeneratedImage,
  ImageClient,
  ImageClientRequest,
  ImageClientResponse,
  ImageErrorCode,
  ImageInput,
  ImageRequest,
} from "./types";
export { ImageGenerationError } from "./types";
export type { ImageUploader, ImageUploaderDeps, UploadedImage } from "./uploader";
export { createImageUploader } from "./uploader";
