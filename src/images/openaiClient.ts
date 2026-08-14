/**
 * The real image client, backed by the OpenAI Images API.
 *
 * This is the only file in the module that talks to a paid API. `client` is
 * injectable (defaulting to a real `OpenAI` instance), so tests substitute a
 * mock and never reach it. A request with no base/input images calls
 * `images.generate` (pure text-to-image); a request with either calls
 * `images.edit`.
 */

import OpenAI, { toFile } from "openai";
import type { ImageModuleConfig } from "./config";
import type { ImageClient, ImageClientRequest, ImageClientResponse } from "./types";

type EditParams = OpenAI.Images.ImageEditParams;
type GenerateParams = OpenAI.Images.ImageGenerateParams;

/**
 * `response_format` is only valid for `dall-e-2`/`dall-e-3`; the GPT image
 * models reject it and always return base64. Only DALL-E models need it set
 * explicitly to get `b64_json` back instead of a `url` this module can't use.
 */
function isGptImageModel(model: string): boolean {
  return model.startsWith("gpt-image");
}

export function createOpenAIImageClient(
  config: ImageModuleConfig,
  client: OpenAI = new OpenAI({ apiKey: config.apiKey }),
): ImageClient {
  return {
    async createImage(params: ImageClientRequest): Promise<ImageClientResponse> {
      const responseFormat = isGptImageModel(params.model)
        ? {}
        : { response_format: "b64_json" as const };

      // Kept as plain strings so the module stays SDK-version agnostic; the
      // SDK narrows them to unions, so the cast happens here at the boundary.
      if (!params.baseImage && (!params.inputImages || params.inputImages.length === 0)) {
        const response = await client.images.generate({
          model: params.model,
          prompt: params.prompt,
          size: params.size as GenerateParams["size"],
          quality: params.quality as GenerateParams["quality"],
          n: params.n,
          ...responseFormat,
        });
        return { data: response.data };
      }

      const baseFile = params.baseImage
        ? await toFile(Buffer.from(params.baseImage.bytes), params.baseImage.fileName, {
            type: params.baseImage.mimeType,
          })
        : undefined;
      const photoFiles = await Promise.all(
        (params.inputImages ?? []).map((photo) =>
          toFile(Buffer.from(photo.bytes), photo.fileName, { type: photo.mimeType }),
        ),
      );
      // Input photos precede the base image, matching a common prompt
      // convention of referring to "the last supplied image" as the edit base.
      const image = baseFile ? [...photoFiles, baseFile] : photoFiles;

      const response = await client.images.edit({
        model: params.model,
        image,
        prompt: params.prompt,
        size: params.size as EditParams["size"],
        quality: params.quality as EditParams["quality"],
        n: params.n,
        ...responseFormat,
      });
      return { data: response.data };
    },
  };
}
