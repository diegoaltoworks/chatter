/**
 * Generate-or-serve-from-cache orchestration.
 *
 * The request is hashed into a deterministic key before anything paid
 * happens, and checked against the cache first - only a miss or an expired
 * entry reaches the image generator and Cloudinary.
 */

import { type ImageCacheStore, isCacheEntryFresh, publicIdForRequest } from "./cache";
import type { CloudinaryModuleConfig } from "./cloudinaryConfig";
import { isCloudinaryConfigured } from "./cloudinaryConfig";
import type { ImageGenerator } from "./generator";
import { type CloudinaryUploadClient, ImageGenerationError, type ImageRequest } from "./types";

export interface ImageUploaderDeps {
  generator: ImageGenerator;
  uploadClient: CloudinaryUploadClient;
  cacheStore: ImageCacheStore;
  /** Clock, injectable so cache-freshness tests don't depend on real time. */
  now?: () => number;
}

export interface UploadedImage {
  url: string;
  /** True when served from cache without generating or uploading anything new. */
  cached: boolean;
}

export interface ImageUploader {
  isConfigured(): boolean;
  /**
   * True when `request` already has a fresh cached upload.
   *
   * Lets a caller decide whether to spend a spend-guard unit *before* calling
   * `getOrCreateImage` - a cache hit costs nothing, so it must not touch a
   * daily cap. Throws the same `not_configured` error `getOrCreateImage`
   * would, so a caller that checks this first sees a consistent error no
   * matter which method it called.
   */
  peekCached(request: ImageRequest): Promise<boolean>;
  getOrCreateImage(request: ImageRequest): Promise<UploadedImage>;
}

export function createImageUploader(
  config: CloudinaryModuleConfig,
  deps: ImageUploaderDeps,
): ImageUploader {
  const now = deps.now ?? Date.now;

  function cacheKey(request: ImageRequest): string {
    if (!isCloudinaryConfigured(config)) {
      throw new ImageGenerationError("not_configured", "Image upload is not configured");
    }
    return publicIdForRequest(request.prompt, request);
  }

  return {
    // A cache hit never needs the generator, but a fresh upload does — both
    // must be configured for this uploader to actually work end to end.
    isConfigured: () => isCloudinaryConfigured(config) && deps.generator.isConfigured(),

    async peekCached(request: ImageRequest): Promise<boolean> {
      const publicId = cacheKey(request);
      const cached = await deps.cacheStore.get(publicId);
      return !!cached && isCacheEntryFresh(cached, now());
    },

    async getOrCreateImage(request: ImageRequest): Promise<UploadedImage> {
      // Hashed before any paid work, so a cache hit costs nothing.
      const publicId = cacheKey(request);
      const nowMs = now();

      const cached = await deps.cacheStore.get(publicId);
      if (cached && isCacheEntryFresh(cached, nowMs)) {
        return { url: cached.url, cached: true };
      }

      const generated = await deps.generator.generateImage(request);
      const uploaded = await deps.uploadClient.upload({
        imageBytes: generated.imageBytes,
        publicId,
        folder: config.folder,
      });

      await deps.cacheStore.set(publicId, { url: uploaded.secureUrl, createdAt: nowMs });
      return { url: uploaded.secureUrl, cached: false };
    },
  };
}
