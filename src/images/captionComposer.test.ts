import { describe, expect, test } from "bun:test";
import { createCaptionComposer } from "./captionComposer";

describe("randomCaption", () => {
  test("returns an empty string for an empty pool", () => {
    const composer = createCaptionComposer({ pool: [] });
    expect(composer.randomCaption("a cat")).toBe("");
  });

  test("interpolates {subject}", () => {
    const composer = createCaptionComposer({ pool: ["Here is your {subject}."], random: () => 0 });
    expect(composer.randomCaption("cat")).toBe("Here is your cat.");
  });

  test("skips templates that need a subject when none is given", () => {
    const composer = createCaptionComposer({
      pool: ["Needs a {subject}.", "Fine either way."],
      random: () => 0,
    });
    expect(composer.randomCaption()).toBe("Fine either way.");
  });

  test("is deterministic given an injected random", () => {
    const composer = createCaptionComposer({ pool: ["one", "two", "three"], random: () => 0.5 });
    expect(composer.randomCaption()).toBe("two");
  });
});

describe("composeCaption", () => {
  test("uses the pool when no compose function is given", async () => {
    const composer = createCaptionComposer({ pool: ["fallback"] });
    expect(await composer.composeCaption({ subject: "cat" })).toBe("fallback");
  });

  test("returns the composed text on success", async () => {
    const composer = createCaptionComposer({
      pool: ["fallback"],
      compose: async () => "a tailored caption",
    });
    expect(await composer.composeCaption({ subject: "cat" })).toBe("a tailored caption");
  });

  test("falls back to the pool when compose throws", async () => {
    const composer = createCaptionComposer({
      pool: ["fallback"],
      compose: async () => {
        throw new Error("boom");
      },
    });
    expect(await composer.composeCaption({ subject: "cat" })).toBe("fallback");
  });

  test("falls back to the pool when compose exceeds the timeout", async () => {
    const composer = createCaptionComposer({
      pool: ["fallback"],
      timeoutMs: 5,
      compose: () => new Promise((resolve) => setTimeout(() => resolve("too late"), 50)),
    });
    expect(await composer.composeCaption({ subject: "cat" })).toBe("fallback");
  });

  test("falls back to the pool when compose returns an empty string", async () => {
    const composer = createCaptionComposer({ pool: ["fallback"], compose: async () => "   " });
    expect(await composer.composeCaption({ subject: "cat" })).toBe("fallback");
  });

  test("falls back to the pool when compose returns an overlong string", async () => {
    const composer = createCaptionComposer({
      pool: ["fallback"],
      compose: async () => "x".repeat(400),
    });
    expect(await composer.composeCaption({ subject: "cat" })).toBe("fallback");
  });

  test("never throws even without a fallback pool", async () => {
    const composer = createCaptionComposer({
      pool: [],
      compose: async () => {
        throw new Error("boom");
      },
    });
    expect(await composer.composeCaption({ subject: "cat" })).toBe("");
  });
});
