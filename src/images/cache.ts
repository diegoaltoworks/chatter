/**
 * Image cache - deterministic keying and freshness, no I/O.
 *
 * The store itself is injected ({@link ImageCacheStore}): a host backs it with
 * whatever it wants (see `./cacheStore` for the shipped Turso binding), so
 * this file stays free of any DB client.
 */

import { createHash } from "node:crypto";
import type { ImageInput } from "./types";

/** A cached upload: where it lives, and when it was created. */
export interface ImageCacheEntry {
  url: string;
  /** Epoch milliseconds. */
  createdAt: number;
}

/** Structural cache dependency - a host implements this against its own storage. */
export interface ImageCacheStore {
  get(key: string): Promise<ImageCacheEntry | null>;
  set(key: string, entry: ImageCacheEntry): Promise<void>;
}

/** Identical requests are served from cache for this long before regenerating. */
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Deterministic cache key (and Cloudinary `public_id`) for a request: the
 * prompt plus any base/input images. The same prompt against a different
 * photo must be a different picture.
 */
export function publicIdForRequest(
  prompt: string,
  images?: { baseImage?: ImageInput; inputImages?: ImageInput[] },
): string {
  const hash = createHash("sha256").update(prompt);
  if (images?.baseImage) hash.update(images.baseImage.bytes);
  for (const image of images?.inputImages ?? []) {
    hash.update(image.bytes);
  }
  return hash.digest("hex");
}

export function isCacheEntryFresh(entry: ImageCacheEntry, now: number): boolean {
  return now - entry.createdAt < CACHE_TTL_MS;
}
