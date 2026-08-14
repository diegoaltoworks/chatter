import { describe, expect, test } from "bun:test";
import { createImageGenerator } from "./generator";
import type { ImageClient, ImageClientRequest } from "./types";
import { ImageGenerationError } from "./types";

const config = { apiKey: "sk-test", model: "gpt-image-1", size: "1024x1024", quality: "medium" };

function fakeClient(
  handler: (params: ImageClientRequest) => Promise<{ data?: Array<{ b64_json?: string | null }> }>,
): ImageClient {
  return { createImage: handler };
}

describe("createImageGenerator", () => {
  test("isConfigured reflects the config", () => {
    expect(
      createImageGenerator(config, { client: fakeClient(async () => ({})) }).isConfigured(),
    ).toBe(true);
    expect(
      createImageGenerator(
        { ...config, apiKey: undefined },
        { client: fakeClient(async () => ({})) },
      ).isConfigured(),
    ).toBe(false);
  });

  test("throws not_configured without an api key", async () => {
    const generator = createImageGenerator(
      { ...config, apiKey: undefined },
      { client: fakeClient(async () => ({ data: [{ b64_json: "AA==" }] })) },
    );

    await expect(generator.generateImage({ prompt: "a cat" })).rejects.toMatchObject({
      code: "not_configured",
    });
  });

  test("throws invalid_request for an empty prompt", async () => {
    const generator = createImageGenerator(config, {
      client: fakeClient(async () => ({ data: [{ b64_json: "AA==" }] })),
    });

    await expect(generator.generateImage({ prompt: "   " })).rejects.toMatchObject({
      code: "invalid_request",
    });
  });

  test("returns decoded image bytes on success", async () => {
    const b64 = Buffer.from("hello").toString("base64");
    const generator = createImageGenerator(config, {
      client: fakeClient(async () => ({ data: [{ b64_json: b64 }] })),
    });

    const result = await generator.generateImage({ prompt: "a cat" });

    expect(result.b64).toBe(b64);
    expect(Buffer.from(result.imageBytes).toString()).toBe("hello");
  });

  test("omits baseImage/inputImages from the client call when not supplied", async () => {
    let captured: ImageClientRequest | undefined;
    const generator = createImageGenerator(config, {
      client: fakeClient(async (params) => {
        captured = params;
        return { data: [{ b64_json: "AA==" }] };
      }),
    });

    await generator.generateImage({ prompt: "a cat" });

    expect(captured?.baseImage).toBeUndefined();
    expect(captured?.inputImages).toBeUndefined();
  });

  test("passes baseImage and inputImages through to the client", async () => {
    let captured: ImageClientRequest | undefined;
    const generator = createImageGenerator(config, {
      client: fakeClient(async (params) => {
        captured = params;
        return { data: [{ b64_json: "AA==" }] };
      }),
    });

    await generator.generateImage({
      prompt: "a cat",
      baseImage: { bytes: new Uint8Array([1]) },
      inputImages: [
        { bytes: new Uint8Array([2]) },
        { bytes: new Uint8Array([3]), mimeType: "image/jpeg" },
      ],
    });

    expect(captured?.baseImage).toEqual({
      bytes: new Uint8Array([1]),
      fileName: "base.png",
      mimeType: "image/png",
    });
    expect(captured?.inputImages).toEqual([
      { bytes: new Uint8Array([2]), fileName: "photo-1.png", mimeType: "image/png" },
      { bytes: new Uint8Array([3]), fileName: "photo-2.jpg", mimeType: "image/jpeg" },
    ]);
  });

  test("maps a moderation-flavoured error to the moderation code", async () => {
    const generator = createImageGenerator(config, {
      client: fakeClient(async () => {
        throw new Error("Your request was rejected as a result of our safety system.");
      }),
    });

    await expect(generator.generateImage({ prompt: "a cat" })).rejects.toMatchObject({
      code: "moderation",
    });
  });

  test("maps an unrecognised error to api_error", async () => {
    const generator = createImageGenerator(config, {
      client: fakeClient(async () => {
        throw new Error("network blip");
      }),
    });

    await expect(generator.generateImage({ prompt: "a cat" })).rejects.toMatchObject({
      code: "api_error",
    });
  });

  test("throws api_error when the client returns no image data", async () => {
    const generator = createImageGenerator(config, {
      client: fakeClient(async () => ({ data: [] })),
    });

    await expect(generator.generateImage({ prompt: "a cat" })).rejects.toMatchObject({
      code: "api_error",
    });
  });

  test("passes through an ImageGenerationError thrown by the client unchanged", async () => {
    const generator = createImageGenerator(config, {
      client: fakeClient(async () => {
        throw new ImageGenerationError("moderation", "blocked");
      }),
    });

    await expect(generator.generateImage({ prompt: "a cat" })).rejects.toMatchObject({
      code: "moderation",
      message: "blocked",
    });
  });
});
