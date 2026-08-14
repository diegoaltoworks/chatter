import { describe, expect, test } from "bun:test";
import { createCloudinaryUploadClient } from "./cloudinaryClient";
import { ImageGenerationError } from "./types";

const config = { cloudName: "cloud", apiKey: "key", apiSecret: "secret", folder: "generated" };

describe("createCloudinaryUploadClient", () => {
  test("throws not_configured when credentials are missing", async () => {
    const client = createCloudinaryUploadClient(
      { folder: "generated" },
      (async () => new Response("{}")) as unknown as typeof fetch,
    );

    await expect(
      client.upload({ imageBytes: new Uint8Array([1]), publicId: "a", folder: "generated" }),
    ).rejects.toThrow(ImageGenerationError);
  });

  test("posts a signed multipart form and returns the secure url", async () => {
    let capturedUrl = "";
    let capturedForm: FormData | undefined;
    const client = createCloudinaryUploadClient(config, (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      capturedUrl = String(input);
      capturedForm = init?.body as FormData;
      return new Response(JSON.stringify({ secure_url: "https://cloudinary.example/a.png" }), {
        status: 200,
      });
    }) as unknown as typeof fetch);

    const result = await client.upload({
      imageBytes: new Uint8Array([1, 2, 3]),
      publicId: "abc",
      folder: "generated",
    });

    expect(result).toEqual({ secureUrl: "https://cloudinary.example/a.png" });
    expect(capturedUrl).toBe("https://api.cloudinary.com/v1_1/cloud/image/upload");
    expect(capturedForm?.get("public_id")).toBe("abc");
    expect(capturedForm?.get("folder")).toBe("generated");
    expect(capturedForm?.get("api_key")).toBe("key");
  });

  test("throws api_error on a non-2xx response", async () => {
    const client = createCloudinaryUploadClient(
      config,
      (async () => new Response("bad request", { status: 400 })) as unknown as typeof fetch,
    );

    await expect(
      client.upload({ imageBytes: new Uint8Array([1]), publicId: "a", folder: "generated" }),
    ).rejects.toThrow(ImageGenerationError);
  });

  test("throws api_error when the response has no secure_url", async () => {
    const client = createCloudinaryUploadClient(
      config,
      (async () => new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch,
    );

    await expect(
      client.upload({ imageBytes: new Uint8Array([1]), publicId: "a", folder: "generated" }),
    ).rejects.toThrow("returned no secure_url");
  });
});
