import { describe, expect, test } from "bun:test";
import { type ImageCacheEntry, type ImageCacheStore, publicIdForRequest } from "./cache";
import type { ImageGenerator } from "./generator";
import { ImageGenerationError } from "./types";
import { createImageUploader } from "./uploader";

const config = { cloudName: "cloud", apiKey: "key", apiSecret: "secret", folder: "generated" };

function memoryCacheStore(): ImageCacheStore {
  const rows = new Map<string, ImageCacheEntry>();
  return {
    async get(key) {
      return rows.get(key) ?? null;
    },
    async set(key, entry) {
      rows.set(key, entry);
    },
  };
}

function countingGenerator(): { generator: ImageGenerator; calls: { count: number } } {
  const calls = { count: 0 };
  const generator: ImageGenerator = {
    isConfigured: () => true,
    async generateImage() {
      calls.count += 1;
      return { b64: "AA==", imageBytes: new Uint8Array([0]) };
    },
  };
  return { generator, calls };
}

describe("createImageUploader", () => {
  test("isConfigured is false when Cloudinary is unconfigured", () => {
    const uploader = createImageUploader(
      { folder: "generated" },
      {
        generator: countingGenerator().generator,
        uploadClient: { upload: async () => ({ secureUrl: "https://x/y.png" }) },
        cacheStore: memoryCacheStore(),
      },
    );
    expect(uploader.isConfigured()).toBe(false);
  });

  test("isConfigured is false when Cloudinary is set but the generator is not", () => {
    const uploader = createImageUploader(config, {
      generator: {
        isConfigured: () => false,
        generateImage: async () => ({ b64: "", imageBytes: new Uint8Array() }),
      },
      uploadClient: { upload: async () => ({ secureUrl: "https://x/y.png" }) },
      cacheStore: memoryCacheStore(),
    });
    expect(uploader.isConfigured()).toBe(false);
  });

  test("isConfigured is true when both Cloudinary and the generator are set", () => {
    const uploader = createImageUploader(config, {
      generator: countingGenerator().generator,
      uploadClient: { upload: async () => ({ secureUrl: "https://x/y.png" }) },
      cacheStore: memoryCacheStore(),
    });
    expect(uploader.isConfigured()).toBe(true);
  });

  test("a cache hit never reaches the generator or the upload client", async () => {
    const cacheStore = memoryCacheStore();
    const { generator, calls } = countingGenerator();
    let uploadCalls = 0;
    const uploader = createImageUploader(config, {
      generator,
      uploadClient: {
        upload: async () => {
          uploadCalls += 1;
          return { secureUrl: "https://cdn.example/fresh.png" };
        },
      },
      cacheStore,
      now: () => 1000,
    });

    const first = await uploader.getOrCreateImage({ prompt: "a cat" });
    expect(first).toEqual({ url: "https://cdn.example/fresh.png", cached: false });

    const second = await uploader.getOrCreateImage({ prompt: "a cat" });
    expect(second).toEqual({ url: "https://cdn.example/fresh.png", cached: true });

    expect(calls.count).toBe(1);
    expect(uploadCalls).toBe(1);
  });

  test("an expired cache entry regenerates", async () => {
    const cacheStore = memoryCacheStore();
    await cacheStore.set(publicIdForRequest("a cat"), {
      url: "https://cdn.example/old.png",
      createdAt: 0,
    });
    const { generator, calls } = countingGenerator();
    const uploader = createImageUploader(config, {
      generator,
      uploadClient: { upload: async () => ({ secureUrl: "https://cdn.example/new.png" }) },
      cacheStore,
      now: () => 1000 * 60 * 60 * 24 * 2, // two days later, well past the 24h TTL
    });

    const result = await uploader.getOrCreateImage({ prompt: "a cat" });

    expect(result).toEqual({ url: "https://cdn.example/new.png", cached: false });
    expect(calls.count).toBe(1);
  });

  test("peekCached reports a fresh entry without calling the generator", async () => {
    const cacheStore = memoryCacheStore();
    const { generator, calls } = countingGenerator();
    const uploader = createImageUploader(config, {
      generator,
      uploadClient: { upload: async () => ({ secureUrl: "https://cdn.example/a.png" }) },
      cacheStore,
      now: () => 1000,
    });

    expect(await uploader.peekCached({ prompt: "a cat" })).toBe(false);

    await uploader.getOrCreateImage({ prompt: "a cat" });

    expect(await uploader.peekCached({ prompt: "a cat" })).toBe(true);
    expect(calls.count).toBe(1);
  });

  test("throws not_configured when Cloudinary credentials are missing", async () => {
    const uploader = createImageUploader(
      { folder: "generated" },
      {
        generator: countingGenerator().generator,
        uploadClient: { upload: async () => ({ secureUrl: "https://x/y.png" }) },
        cacheStore: memoryCacheStore(),
      },
    );

    await expect(uploader.getOrCreateImage({ prompt: "a cat" })).rejects.toBeInstanceOf(
      ImageGenerationError,
    );
    await expect(uploader.peekCached({ prompt: "a cat" })).rejects.toMatchObject({
      code: "not_configured",
    });
  });
});
