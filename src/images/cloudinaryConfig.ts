/**
 * Cloudinary upload configuration - pure resolution, no I/O.
 *
 * Same shape as `./config`: the module never reads process.env itself, a host
 * passes an env-shaped record in, and the feature is off when unconfigured.
 */

export interface CloudinaryModuleConfig {
  cloudName?: string;
  apiKey?: string;
  apiSecret?: string;
  /** Cloudinary folder generated images are uploaded into. */
  folder: string;
}

export const DEFAULT_CLOUDINARY_FOLDER = "generated";

/** The env vars this module reads, all optional. */
export interface CloudinaryEnv {
  CLOUDINARY_CLOUD_NAME?: string;
  CLOUDINARY_API_KEY?: string;
  CLOUDINARY_API_SECRET?: string;
  CLOUDINARY_FOLDER?: string;
}

/** First non-empty value wins - an empty env var means "unset", not "use empty string". */
function pick(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => typeof value === "string" && value.length > 0);
}

export function resolveCloudinaryConfig(
  env: CloudinaryEnv = {},
  overrides: Partial<CloudinaryModuleConfig> = {},
): CloudinaryModuleConfig {
  return {
    cloudName: pick(overrides.cloudName, env.CLOUDINARY_CLOUD_NAME),
    apiKey: pick(overrides.apiKey, env.CLOUDINARY_API_KEY),
    apiSecret: pick(overrides.apiSecret, env.CLOUDINARY_API_SECRET),
    folder:
      pick(overrides.folder, env.CLOUDINARY_FOLDER, DEFAULT_CLOUDINARY_FOLDER) ??
      DEFAULT_CLOUDINARY_FOLDER,
  };
}

/** Feature detection: any credential missing, no upload. Narrows the credential fields to `string`. */
export function isCloudinaryConfigured(
  config: CloudinaryModuleConfig,
): config is CloudinaryModuleConfig & { cloudName: string; apiKey: string; apiSecret: string } {
  return Boolean(config.cloudName && config.apiKey && config.apiSecret);
}
