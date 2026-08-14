/**
 * Image module configuration - pure resolution, no I/O.
 *
 * The module never reads process.env itself; a host passes an env-shaped
 * record in. That keeps the module liftable and lets tests describe
 * configured and unconfigured worlds without touching the real environment.
 */

export interface ImageModuleConfig {
  /** Absent or empty means the feature is off; the server still boots. */
  apiKey?: string;
  model: string;
  size: string;
  quality: string;
}

export const DEFAULT_IMAGE_MODEL = "gpt-image-1";
export const DEFAULT_IMAGE_SIZE = "1024x1024";
export const DEFAULT_IMAGE_QUALITY = "medium";

/** The env vars this module reads, all optional. */
export interface ImageEnv {
  OPENAI_API_KEY?: string;
  IMAGE_MODEL?: string;
  IMAGE_SIZE?: string;
  IMAGE_QUALITY?: string;
}

/** First non-empty value wins - an empty env var means "unset", not "use empty string". */
function pick(...values: Array<string | undefined>): string {
  return values.find((value) => typeof value === "string" && value.length > 0) ?? "";
}

export function resolveImageConfig(
  env: ImageEnv = {},
  overrides: Partial<ImageModuleConfig> = {},
): ImageModuleConfig {
  return {
    apiKey: overrides.apiKey ?? env.OPENAI_API_KEY,
    model: pick(overrides.model, env.IMAGE_MODEL, DEFAULT_IMAGE_MODEL),
    size: pick(overrides.size, env.IMAGE_SIZE, DEFAULT_IMAGE_SIZE),
    quality: pick(overrides.quality, env.IMAGE_QUALITY, DEFAULT_IMAGE_QUALITY),
  };
}

/** Feature detection: no key, no image generation. */
export function isImageConfigured(config: ImageModuleConfig): boolean {
  return typeof config.apiKey === "string" && config.apiKey.length > 0;
}
