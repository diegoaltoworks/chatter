import { describe, expect, test } from "bun:test";
import type OpenAI from "openai";
import { createOpenAIImageClient } from "./openaiClient";

const config = { apiKey: "sk-test", model: "gpt-image-1", size: "1024x1024", quality: "medium" };

describe("createOpenAIImageClient", () => {
  test("calls images.generate for a request with no images", async () => {
    let capturedModel = "";
    const fakeClient = {
      images: {
        generate: async (params: { model: string }) => {
          capturedModel = params.model;
          return { data: [{ b64_json: "AA==" }] };
        },
        edit: async () => {
          throw new Error("edit should not be called");
        },
      },
    } as unknown as OpenAI;

    const client = createOpenAIImageClient(config, fakeClient);
    const result = await client.createImage({
      model: "gpt-image-1",
      prompt: "a cat",
      size: "1024x1024",
      quality: "medium",
      n: 1,
    });

    expect(capturedModel).toBe("gpt-image-1");
    expect(result.data?.[0]?.b64_json).toBe("AA==");
  });

  test("omits response_format for a GPT image model", async () => {
    let captured: Record<string, unknown> = {};
    const fakeClient = {
      images: {
        generate: async (params: Record<string, unknown>) => {
          captured = params;
          return { data: [{ b64_json: "AA==" }] };
        },
        edit: async () => {
          throw new Error("edit should not be called");
        },
      },
    } as unknown as OpenAI;

    const client = createOpenAIImageClient(config, fakeClient);
    await client.createImage({
      model: "gpt-image-1",
      prompt: "a cat",
      size: "1024x1024",
      quality: "medium",
      n: 1,
    });

    expect(captured.response_format).toBeUndefined();
  });

  test("sets response_format b64_json for a non-GPT image model", async () => {
    let captured: Record<string, unknown> = {};
    const fakeClient = {
      images: {
        generate: async (params: Record<string, unknown>) => {
          captured = params;
          return { data: [{ b64_json: "AA==" }] };
        },
        edit: async () => {
          throw new Error("edit should not be called");
        },
      },
    } as unknown as OpenAI;

    const client = createOpenAIImageClient(config, fakeClient);
    await client.createImage({
      model: "dall-e-3",
      prompt: "a cat",
      size: "1024x1024",
      quality: "medium",
      n: 1,
    });

    expect(captured.response_format).toBe("b64_json");
  });

  test("calls images.edit when a base image is supplied", async () => {
    let editCalled = false;
    const fakeClient = {
      images: {
        generate: async () => {
          throw new Error("generate should not be called");
        },
        edit: async () => {
          editCalled = true;
          return { data: [{ b64_json: "AA==" }] };
        },
      },
    } as unknown as OpenAI;

    const client = createOpenAIImageClient(config, fakeClient);
    await client.createImage({
      model: "gpt-image-1",
      prompt: "a cat",
      size: "1024x1024",
      quality: "medium",
      n: 1,
      baseImage: { bytes: new Uint8Array([1]), fileName: "base.png", mimeType: "image/png" },
    });

    expect(editCalled).toBe(true);
  });

  test("calls images.edit when input images are supplied without a base image", async () => {
    let editCalled = false;
    const fakeClient = {
      images: {
        generate: async () => {
          throw new Error("generate should not be called");
        },
        edit: async () => {
          editCalled = true;
          return { data: [{ b64_json: "AA==" }] };
        },
      },
    } as unknown as OpenAI;

    const client = createOpenAIImageClient(config, fakeClient);
    await client.createImage({
      model: "gpt-image-1",
      prompt: "a cat",
      size: "1024x1024",
      quality: "medium",
      n: 1,
      inputImages: [{ bytes: new Uint8Array([1]), fileName: "photo-1.png", mimeType: "image/png" }],
    });

    expect(editCalled).toBe(true);
  });

  test("sends input photos before the base image, in file order", async () => {
    let capturedImages: unknown;
    const fakeClient = {
      images: {
        generate: async () => {
          throw new Error("generate should not be called");
        },
        edit: async (params: { image: unknown }) => {
          capturedImages = params.image;
          return { data: [{ b64_json: "AA==" }] };
        },
      },
    } as unknown as OpenAI;

    const client = createOpenAIImageClient(config, fakeClient);
    await client.createImage({
      model: "gpt-image-1",
      prompt: "a cat",
      size: "1024x1024",
      quality: "medium",
      n: 1,
      baseImage: { bytes: new Uint8Array([9]), fileName: "base.png", mimeType: "image/png" },
      inputImages: [{ bytes: new Uint8Array([1]), fileName: "photo-1.png", mimeType: "image/png" }],
    });

    expect(Array.isArray(capturedImages)).toBe(true);
    const files = capturedImages as Array<{ name: string }>;
    expect(files).toHaveLength(2);
    expect(files[0]?.name).toBe("photo-1.png");
    expect(files[1]?.name).toBe("base.png");
  });
});
