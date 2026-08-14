import { describe, expect, mock, test } from "bun:test";
import type { WAMessage, WASocket } from "@whiskeysockets/baileys";
import { ImageGenerationError } from "../../images/types";
import {
  createWhatsAppImageHandler,
  drawSubject,
  isDrawRequest,
  type WhatsAppImageHandlerDeps,
} from "./images";

// --- detector / subject cleaner ---

describe("isDrawRequest", () => {
  test("matches generic drawing verbs", () => {
    expect(isDrawRequest("please draw me a cat")).toBe(true);
    expect(isDrawRequest("can you sketch a sunset")).toBe(true);
  });

  test("matches a request verb paired with a picture noun", () => {
    expect(isDrawRequest("generate me a picture of a dog")).toBe(true);
    expect(isDrawRequest("make an image of a robot")).toBe(true);
  });

  test("does not match unrelated chat", () => {
    expect(isDrawRequest("what's the weather today?")).toBe(false);
  });

  test("does not match a bare mention of a picture/photo with no request verb", () => {
    expect(isDrawRequest("nice photo!")).toBe(false);
    expect(isDrawRequest("what's in this photo?")).toBe(false);
    expect(isDrawRequest("did you see that picture I sent?")).toBe(false);
    expect(isDrawRequest("the image quality on this call is terrible")).toBe(false);
  });

  test("a caller-supplied pattern overrides the default", () => {
    expect(isDrawRequest("render me a scene", { detectPattern: /\brender\b/i })).toBe(true);
    expect(isDrawRequest("draw me a cat", { detectPattern: /\brender\b/i })).toBe(false);
  });

  test("a caller-supplied global/sticky pattern does not carry lastIndex state across calls", () => {
    const detectPattern = /draw/g;
    expect(isDrawRequest("draw me a cat", { detectPattern })).toBe(true);
    expect(isDrawRequest("draw me a dog", { detectPattern })).toBe(true);
    expect(isDrawRequest("draw me a fox", { detectPattern })).toBe(true);
  });
});

describe("drawSubject", () => {
  test("strips mentions, politeness, and the draw verb", () => {
    expect(drawSubject("@1234 please draw me a cat")).toBe("cat");
  });

  test("strips a can/could/will you preamble", () => {
    expect(drawSubject("Can you sketch a sunset")).toBe("sunset");
  });

  test("keeps the 'n' in 'an' rather than swallowing it into the subject", () => {
    expect(drawSubject("draw me an octopus")).toBe("octopus");
    expect(drawSubject("sketch an owl at night")).toBe("owl at night");
  });

  test("falls back to the trimmed original when stripping leaves nothing", () => {
    expect(drawSubject("draw", { stripPatterns: [/^draw$/i] })).toBe("draw");
  });
});

// --- handler ---

function fakeSocket(): WASocket {
  return { sendMessage: mock(async () => undefined) } as unknown as WASocket;
}

function fakeMessage(hasImage = false): WAMessage {
  return { message: hasImage ? { imageMessage: {} } : {} } as unknown as WAMessage;
}

function baseDeps(overrides: Partial<WhatsAppImageHandlerDeps> = {}): WhatsAppImageHandlerDeps {
  return {
    images: {
      isConfigured: () => true,
      peekCached: async () => false,
      getOrCreateImage: async () => ({ url: "https://cdn.example/cat.png", cached: false }),
    },
    ...overrides,
  };
}

describe("createWhatsAppImageHandler", () => {
  test("falls through (returns false) when images is not configured", async () => {
    const handler = createWhatsAppImageHandler(
      baseDeps({ images: { ...baseDeps().images, isConfigured: () => false } }),
    );
    const sock = fakeSocket();

    const handled = await handler({
      sock,
      message: fakeMessage(),
      chatId: "chat@g.us",
      senderId: "+1",
      text: "draw me a cat",
      hasPhoto: false,
    });

    expect(handled).toBe(false);
    expect(sock.sendMessage).not.toHaveBeenCalled();
  });

  test("falls through (returns false) when the text is not a draw request", async () => {
    const handler = createWhatsAppImageHandler(baseDeps());
    const sock = fakeSocket();

    const handled = await handler({
      sock,
      message: fakeMessage(),
      chatId: "chat@g.us",
      senderId: "+1",
      text: "how are you?",
      hasPhoto: false,
    });

    expect(handled).toBe(false);
    expect(sock.sendMessage).not.toHaveBeenCalled();
  });

  test("text-only request sends an ack then the generated image with no input images", async () => {
    let seenRequest: unknown;
    const handler = createWhatsAppImageHandler(
      baseDeps({
        images: {
          isConfigured: () => true,
          peekCached: async () => false,
          getOrCreateImage: async (request) => {
            seenRequest = request;
            return { url: "https://cdn.example/cat.png", cached: false };
          },
        },
        strings: { ack: "Working on it!" },
      }),
    );
    const sock = fakeSocket();
    const message = fakeMessage();

    const handled = await handler({
      sock,
      message,
      chatId: "chat@g.us",
      senderId: "+1",
      text: "please draw me a cat",
      hasPhoto: false,
    });

    expect(handled).toBe(true);
    expect(seenRequest).toMatchObject({ prompt: "cat", inputImages: undefined });
    expect(sock.sendMessage).toHaveBeenCalledTimes(2);
    expect(sock.sendMessage).toHaveBeenNthCalledWith(
      1,
      "chat@g.us",
      { text: "Working on it!" },
      { quoted: message },
    );
    expect(sock.sendMessage).toHaveBeenNthCalledWith(
      2,
      "chat@g.us",
      { image: { url: "https://cdn.example/cat.png" } },
      { quoted: message },
    );
  });

  test("a photo + caption downloads the photo and passes it as an input image", async () => {
    let seenRequest: { inputImages?: Array<{ bytes: Uint8Array }> } | undefined;
    const handler = createWhatsAppImageHandler(
      baseDeps({
        images: {
          isConfigured: () => true,
          peekCached: async () => false,
          getOrCreateImage: async (request) => {
            seenRequest = request;
            return { url: "https://cdn.example/composite.png", cached: false };
          },
        },
        downloadPhoto: async () => new Uint8Array([1, 2, 3]),
      }),
    );

    const handled = await handler({
      sock: fakeSocket(),
      message: fakeMessage(true),
      chatId: "chat@g.us",
      senderId: "+1",
      text: "draw me here",
      hasPhoto: true,
    });

    expect(handled).toBe(true);
    expect(seenRequest?.inputImages?.[0]?.bytes).toEqual(new Uint8Array([1, 2, 3]));
  });

  test("a cache hit skips checkAndReserve entirely", async () => {
    const checkAndReserve = mock(async () => ({ allowed: true }));
    const handler = createWhatsAppImageHandler(
      baseDeps({
        images: {
          isConfigured: () => true,
          peekCached: async () => true,
          getOrCreateImage: async () => ({ url: "https://cdn.example/cached.png", cached: true }),
        },
        checkAndReserve,
      }),
    );

    await handler({
      sock: fakeSocket(),
      message: fakeMessage(),
      chatId: "chat@g.us",
      senderId: "+1",
      text: "draw a cat",
      hasPhoto: false,
    });

    expect(checkAndReserve).not.toHaveBeenCalled();
  });

  test("a blocked reservation replies with the configured limit string and never generates", async () => {
    const getOrCreateImage = mock(async () => ({ url: "https://x/y.png", cached: false }));
    const handler = createWhatsAppImageHandler(
      baseDeps({
        images: { isConfigured: () => true, peekCached: async () => false, getOrCreateImage },
        checkAndReserve: async () => ({ allowed: false }),
        strings: { limitReached: "Not today." },
      }),
    );
    const sock = fakeSocket();
    const message = fakeMessage();

    const handled = await handler({
      sock,
      message,
      chatId: "chat@g.us",
      senderId: "+1",
      text: "draw a cat",
      hasPhoto: false,
    });

    expect(handled).toBe(true);
    expect(getOrCreateImage).not.toHaveBeenCalled();
    expect(sock.sendMessage).toHaveBeenCalledWith(
      "chat@g.us",
      { text: "Not today." },
      { quoted: message },
    );
  });

  test("a moderation error maps to moderationBlocked, not the generic error string", async () => {
    const handler = createWhatsAppImageHandler(
      baseDeps({
        images: {
          isConfigured: () => true,
          peekCached: async () => false,
          getOrCreateImage: async () => {
            throw new ImageGenerationError("moderation", "blocked");
          },
        },
        strings: { moderationBlocked: "Can't draw that.", error: "Something went wrong." },
      }),
    );
    const sock = fakeSocket();
    const message = fakeMessage();

    const handled = await handler({
      sock,
      message,
      chatId: "chat@g.us",
      senderId: "+1",
      text: "draw a cat",
      hasPhoto: false,
    });

    expect(handled).toBe(true);
    expect(sock.sendMessage).toHaveBeenCalledWith(
      "chat@g.us",
      { text: "Can't draw that." },
      { quoted: message },
    );
  });

  test("a moderation error from a foreign class (a different `./images` bundle) is still recognised", async () => {
    // `./whatsapp` and `./images` are separate esbuild bundles, each with
    // its own copy of `ImageGenerationError` — `instanceof` would not
    // recognise one bundle's error in the other. Simulate that with an
    // unrelated class carrying the same `name`/`code` shape, rather than
    // `ImageGenerationError` imported above, which would pass even a broken
    // `instanceof` check because it's the same class object in-process.
    class ForeignImageGenerationError extends Error {
      code = "moderation";
      constructor(message: string) {
        super(message);
        this.name = "ImageGenerationError";
      }
    }
    const handler = createWhatsAppImageHandler(
      baseDeps({
        images: {
          isConfigured: () => true,
          peekCached: async () => false,
          getOrCreateImage: async () => {
            throw new ForeignImageGenerationError("blocked");
          },
        },
        strings: { moderationBlocked: "Can't draw that.", error: "Something went wrong." },
      }),
    );
    const sock = fakeSocket();
    const message = fakeMessage();

    const handled = await handler({
      sock,
      message,
      chatId: "chat@g.us",
      senderId: "+1",
      text: "draw a cat",
      hasPhoto: false,
    });

    expect(handled).toBe(true);
    expect(sock.sendMessage).toHaveBeenCalledWith(
      "chat@g.us",
      { text: "Can't draw that." },
      { quoted: message },
    );
  });

  test("a generic failure maps to the error string and is handled, not thrown", async () => {
    const handler = createWhatsAppImageHandler(
      baseDeps({
        images: {
          isConfigured: () => true,
          peekCached: async () => false,
          getOrCreateImage: async () => {
            throw new Error("network blip");
          },
        },
        strings: { error: "Something went wrong." },
      }),
    );
    const sock = fakeSocket();
    const message = fakeMessage();

    const handled = await handler({
      sock,
      message,
      chatId: "chat@g.us",
      senderId: "+1",
      text: "draw a cat",
      hasPhoto: false,
    });

    expect(handled).toBe(true);
    expect(sock.sendMessage).toHaveBeenCalledWith(
      "chat@g.us",
      { text: "Something went wrong." },
      { quoted: message },
    );
  });

  test("an unset error string means silent failure — no reply sent", async () => {
    const handler = createWhatsAppImageHandler(
      baseDeps({
        images: {
          isConfigured: () => true,
          peekCached: async () => false,
          getOrCreateImage: async () => {
            throw new Error("boom");
          },
        },
      }),
    );
    const sock = fakeSocket();

    const handled = await handler({
      sock,
      message: fakeMessage(),
      chatId: "chat@g.us",
      senderId: "+1",
      text: "draw a cat",
      hasPhoto: false,
    });

    expect(handled).toBe(true);
    expect(sock.sendMessage).not.toHaveBeenCalled();
  });

  test("uses the caption composer for the image reply when configured", async () => {
    const handler = createWhatsAppImageHandler(
      baseDeps({
        captionComposer: { composeCaption: async ({ subject }) => `A fine ${subject}.` },
      }),
    );
    const sock = fakeSocket();
    const message = fakeMessage();

    await handler({
      sock,
      message,
      chatId: "chat@g.us",
      senderId: "+1",
      text: "draw a cat",
      hasPhoto: false,
    });

    expect(sock.sendMessage).toHaveBeenCalledWith(
      "chat@g.us",
      { image: { url: "https://cdn.example/cat.png" }, caption: "A fine cat." },
      { quoted: message },
    );
  });
});
