/**
 * The real Cloudinary upload client, over plain HTTP.
 *
 * This is the only file in the module that talks to Cloudinary. `fetchImpl`
 * is injected (defaulting to the global `fetch`), so tests substitute a mock
 * and never make a real upload. No Cloudinary SDK dependency is needed -
 * signed uploads are a handful of form fields over `fetch`.
 */

import { type CloudinaryModuleConfig, isCloudinaryConfigured } from "./cloudinaryConfig";
import { signCloudinaryParams } from "./cloudinarySignature";
import type { CloudinaryUploadClient, CloudinaryUploadRequest } from "./types";
import { ImageGenerationError } from "./types";

interface CloudinaryUploadApiResponse {
  secure_url?: string;
}

export function createCloudinaryUploadClient(
  config: CloudinaryModuleConfig,
  fetchImpl: typeof fetch = fetch,
): CloudinaryUploadClient {
  return {
    async upload({ imageBytes, publicId, folder }: CloudinaryUploadRequest) {
      if (!isCloudinaryConfigured(config)) {
        throw new ImageGenerationError("not_configured", "Image upload is not configured");
      }

      const timestamp = Math.floor(Date.now() / 1000).toString();
      const signature = signCloudinaryParams(
        { folder, public_id: publicId, timestamp },
        config.apiSecret,
      );

      const form = new FormData();
      form.set(
        "file",
        new Blob([Buffer.from(imageBytes)], { type: "image/png" }),
        `${publicId}.png`,
      );
      form.set("public_id", publicId);
      form.set("folder", folder);
      form.set("timestamp", timestamp);
      form.set("api_key", config.apiKey);
      form.set("signature", signature);

      const response = await fetchImpl(
        `https://api.cloudinary.com/v1_1/${config.cloudName}/image/upload`,
        { method: "POST", body: form },
      );

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new ImageGenerationError(
          "api_error",
          `Cloudinary upload failed: ${response.status} ${body}`,
        );
      }

      const data = (await response.json()) as CloudinaryUploadApiResponse;
      if (!data.secure_url) {
        throw new ImageGenerationError("api_error", "Cloudinary upload returned no secure_url");
      }
      return { secureUrl: data.secure_url };
    },
  };
}
