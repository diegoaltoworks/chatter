import { describe, expect, test } from "bun:test";
import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_IMAGE_QUALITY,
  DEFAULT_IMAGE_SIZE,
  isImageConfigured,
  resolveImageConfig,
} from "./config";

describe("resolveImageConfig", () => {
  test("falls back to defaults when nothing is set", () => {
    expect(resolveImageConfig()).toEqual({
      apiKey: undefined,
      model: DEFAULT_IMAGE_MODEL,
      size: DEFAULT_IMAGE_SIZE,
      quality: DEFAULT_IMAGE_QUALITY,
    });
  });

  test("env values win over defaults", () => {
    const config = resolveImageConfig({
      OPENAI_API_KEY: "sk-test",
      IMAGE_MODEL: "custom-model",
      IMAGE_SIZE: "512x512",
      IMAGE_QUALITY: "high",
    });
    expect(config).toEqual({
      apiKey: "sk-test",
      model: "custom-model",
      size: "512x512",
      quality: "high",
    });
  });

  test("overrides win over env", () => {
    const config = resolveImageConfig({ IMAGE_MODEL: "env-model" }, { model: "override-model" });
    expect(config.model).toBe("override-model");
  });

  test("empty env values are treated as unset", () => {
    const config = resolveImageConfig({ IMAGE_MODEL: "" });
    expect(config.model).toBe(DEFAULT_IMAGE_MODEL);
  });
});

describe("isImageConfigured", () => {
  test("false without an api key", () => {
    expect(isImageConfigured(resolveImageConfig())).toBe(false);
  });

  test("true with an api key", () => {
    expect(isImageConfigured(resolveImageConfig({ OPENAI_API_KEY: "sk-test" }))).toBe(true);
  });
});
