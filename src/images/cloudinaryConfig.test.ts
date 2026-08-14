import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CLOUDINARY_FOLDER,
  isCloudinaryConfigured,
  resolveCloudinaryConfig,
} from "./cloudinaryConfig";

describe("resolveCloudinaryConfig", () => {
  test("falls back to defaults when nothing is set", () => {
    expect(resolveCloudinaryConfig()).toEqual({
      cloudName: undefined,
      apiKey: undefined,
      apiSecret: undefined,
      folder: DEFAULT_CLOUDINARY_FOLDER,
    });
  });

  test("env values win over defaults", () => {
    const config = resolveCloudinaryConfig({
      CLOUDINARY_CLOUD_NAME: "cloud",
      CLOUDINARY_API_KEY: "key",
      CLOUDINARY_API_SECRET: "secret",
      CLOUDINARY_FOLDER: "custom",
    });
    expect(config).toEqual({
      cloudName: "cloud",
      apiKey: "key",
      apiSecret: "secret",
      folder: "custom",
    });
  });

  test("overrides win over env", () => {
    const config = resolveCloudinaryConfig({ CLOUDINARY_FOLDER: "env" }, { folder: "override" });
    expect(config.folder).toBe("override");
  });
});

describe("isCloudinaryConfigured", () => {
  test("false when any credential is missing", () => {
    expect(
      isCloudinaryConfigured(resolveCloudinaryConfig({ CLOUDINARY_CLOUD_NAME: "cloud" })),
    ).toBe(false);
  });

  test("true when all credentials are present", () => {
    const config = resolveCloudinaryConfig({
      CLOUDINARY_CLOUD_NAME: "cloud",
      CLOUDINARY_API_KEY: "key",
      CLOUDINARY_API_SECRET: "secret",
    });
    expect(isCloudinaryConfigured(config)).toBe(true);
  });
});
