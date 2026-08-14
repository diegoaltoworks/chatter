import { describe, expect, test } from "bun:test";
import { CACHE_TTL_MS, isCacheEntryFresh, publicIdForRequest } from "./cache";

describe("publicIdForRequest", () => {
  test("is deterministic for the same prompt", () => {
    expect(publicIdForRequest("a cat")).toBe(publicIdForRequest("a cat"));
  });

  test("differs for different prompts", () => {
    expect(publicIdForRequest("a cat")).not.toBe(publicIdForRequest("a dog"));
  });

  test("differs when a base image is added", () => {
    const withoutImage = publicIdForRequest("a cat");
    const withImage = publicIdForRequest("a cat", {
      baseImage: { bytes: new Uint8Array([1, 2, 3]) },
    });
    expect(withoutImage).not.toBe(withImage);
  });

  test("differs when input images are added", () => {
    const withoutImages = publicIdForRequest("a cat");
    const withImages = publicIdForRequest("a cat", {
      inputImages: [{ bytes: new Uint8Array([9]) }],
    });
    expect(withoutImages).not.toBe(withImages);
  });

  test("same prompt with the same photo hashes identically", () => {
    const photo = { bytes: new Uint8Array([1, 2, 3]) };
    expect(publicIdForRequest("a cat", { inputImages: [photo] })).toBe(
      publicIdForRequest("a cat", { inputImages: [photo] }),
    );
  });
});

describe("isCacheEntryFresh", () => {
  test("true just under the TTL", () => {
    const entry = { url: "https://example.com/a.png", createdAt: 1000 };
    expect(isCacheEntryFresh(entry, 1000 + CACHE_TTL_MS - 1)).toBe(true);
  });

  test("false at or past the TTL", () => {
    const entry = { url: "https://example.com/a.png", createdAt: 1000 };
    expect(isCacheEntryFresh(entry, 1000 + CACHE_TTL_MS)).toBe(false);
  });
});
