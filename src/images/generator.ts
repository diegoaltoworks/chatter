/**
 * Image generation - the API call and its error mapping.
 *
 * Every dependency that costs money is injected, so the test suite never
 * makes a real gpt-image-1 call. Prompt composition is entirely the caller's
 * job (see `ImageRequest.prompt`); this module holds no template or
 * character content.
 */

import { type ImageModuleConfig, isImageConfigured } from "./config";
import {
  type GeneratedImage,
  type ImageClient,
  ImageGenerationError,
  type ImageRequest,
} from "./types";

export interface ImageGeneratorDeps {
  client: ImageClient;
}

export interface ImageGenerator {
  isConfigured(): boolean;
  generateImage(request: ImageRequest): Promise<GeneratedImage>;
}

const MODERATION_PATTERN = /moderation|safety system|content policy|rejected as a result/i;
const DEFAULT_MIME_TYPE = "image/png";

function extensionForMimeType(mimeType: string): string {
  const subtype = mimeType.split("/")[1];
  return subtype === "jpeg" ? "jpg" : subtype || "png";
}

/** Map whatever the image API threw into a typed, switchable error. */
function toImageError(error: unknown): ImageGenerationError {
  if (error instanceof ImageGenerationError) return error;

  const code = (error as { code?: unknown })?.code;
  const message = error instanceof Error ? error.message : String(error);

  if (code === "moderation_blocked" || MODERATION_PATTERN.test(message)) {
    return new ImageGenerationError("moderation", message, { cause: error });
  }
  return new ImageGenerationError("api_error", message, { cause: error });
}

export function createImageGenerator(
  config: ImageModuleConfig,
  deps: ImageGeneratorDeps,
): ImageGenerator {
  return {
    isConfigured: () => isImageConfigured(config),

    async generateImage(request: ImageRequest): Promise<GeneratedImage> {
      if (!isImageConfigured(config)) {
        throw new ImageGenerationError("not_configured", "Image generation is not configured");
      }
      if (request.prompt.trim().length === 0) {
        throw new ImageGenerationError("invalid_request", "Image request has an empty prompt");
      }

      let response: Awaited<ReturnType<ImageClient["createImage"]>>;
      try {
        response = await deps.client.createImage({
          model: config.model,
          prompt: request.prompt,
          size: config.size,
          quality: config.quality,
          n: 1,
          baseImage: request.baseImage
            ? {
                bytes: request.baseImage.bytes,
                mimeType: request.baseImage.mimeType ?? DEFAULT_MIME_TYPE,
                fileName: `base.${extensionForMimeType(request.baseImage.mimeType ?? DEFAULT_MIME_TYPE)}`,
              }
            : undefined,
          inputImages: request.inputImages?.map((image, index) => ({
            bytes: image.bytes,
            mimeType: image.mimeType ?? DEFAULT_MIME_TYPE,
            fileName: `photo-${index + 1}.${extensionForMimeType(image.mimeType ?? DEFAULT_MIME_TYPE)}`,
          })),
        });
      } catch (error) {
        throw toImageError(error);
      }

      const b64 = response?.data?.[0]?.b64_json;
      if (!b64) {
        throw new ImageGenerationError("api_error", "Image API returned no image data");
      }

      return { b64, imageBytes: Uint8Array.from(Buffer.from(b64, "base64")) };
    },
  };
}
