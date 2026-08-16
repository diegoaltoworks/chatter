import { describe, expect, mock, test } from "bun:test";
import type { WAMessage, WASocket } from "@whiskeysockets/baileys";
import type { Logger } from "../../core/logger";
import type { SessionIdentityRegistry } from "../gates";
import type { WhatsAppMessageEvent } from "./channel";
import {
  createWhatsAppMessageRouter,
  type MessageDetector,
  type ParallelDetector,
  type ReplaceDetector,
  type WaDetectorContext,
} from "./router";

function fakeSocket(): WASocket {
  return {
    user: { id: "447700900000@s.whatsapp.net" },
    sendMessage: mock(async () => undefined),
  } as unknown as WASocket;
}

function waEvent(sock: WASocket, overrides: Partial<WAMessage> = {}): WhatsAppMessageEvent {
  return {
    sessionId: "default",
    sock,
    message: {
      key: { remoteJid: "447700900123@s.whatsapp.net", fromMe: false },
      message: { conversation: "hello there" },
      ...overrides,
    } as unknown as WAMessage,
  };
}

function replaceDetector(
  name: string,
  matches: boolean,
  onHandle?: (ctx: WaDetectorContext) => void,
): ReplaceDetector {
  return {
    name,
    mode: "replace",
    test: () => matches,
    handle: async (ctx) => {
      onHandle?.(ctx);
    },
  };
}

function parallelDetector(
  name: string,
  matches: boolean,
  handle: (ctx: WaDetectorContext) => Promise<void>,
): ParallelDetector {
  return { name, mode: "parallel", test: () => matches, handle };
}

function createRouter(
  detectors: MessageDetector[],
  overrides: { fallback?: () => Promise<void>; logger?: Logger } = {},
) {
  const registry: SessionIdentityRegistry = new Map();
  const fallbackCalls: WhatsAppMessageEvent[] = [];
  const fallback = async (event: WhatsAppMessageEvent) => {
    fallbackCalls.push(event);
    await overrides.fallback?.();
  };
  const router = createWhatsAppMessageRouter({
    registry,
    detectors,
    fallback,
    logger: overrides.logger,
  });
  return { router, fallbackCalls };
}

describe("createWhatsAppMessageRouter", () => {
  test("no detector matches -> fallback runs", async () => {
    const handled: string[] = [];
    const detectors: MessageDetector[] = [
      replaceDetector("a", false, () => handled.push("a")),
      replaceDetector("b", false, () => handled.push("b")),
    ];
    const { router, fallbackCalls } = createRouter(detectors);

    await router(waEvent(fakeSocket()));

    expect(handled).toEqual([]);
    expect(fallbackCalls).toHaveLength(1);
  });

  test("only the second of two replace detectors matches -> its handle runs, fallback is skipped", async () => {
    const handled: string[] = [];
    const detectors: MessageDetector[] = [
      replaceDetector("first", false, () => handled.push("first")),
      replaceDetector("second", true, () => handled.push("second")),
    ];
    const { router, fallbackCalls } = createRouter(detectors);

    await router(waEvent(fakeSocket()));

    expect(handled).toEqual(["second"]);
    expect(fallbackCalls).toHaveLength(0);
  });

  test("registration order: the first-registered matching replace detector wins over a later one that would also match", async () => {
    const handled: string[] = [];
    const detectors: MessageDetector[] = [
      replaceDetector("earlier", true, () => handled.push("earlier")),
      replaceDetector("later", true, () => handled.push("later")),
    ];
    const { router, fallbackCalls } = createRouter(detectors);

    await router(waEvent(fakeSocket()));

    expect(handled).toEqual(["earlier"]);
    expect(fallbackCalls).toHaveLength(0);
  });

  test("a throwing parallel detector never blocks other detectors, the fallback, or surfaces as an unhandled rejection", async () => {
    const handled: string[] = [];
    const detectorErrors: Array<[string, unknown]> = [];
    let resolveOther: () => void = () => {};
    const otherRan = new Promise<void>((resolve) => {
      resolveOther = resolve;
    });

    const throwing = parallelDetector("thrower", true, async () => {
      throw new Error("boom");
    });
    const other = parallelDetector("other", true, async () => {
      handled.push("other");
      resolveOther();
    });

    const registry: SessionIdentityRegistry = new Map();
    const fallbackCalls: WhatsAppMessageEvent[] = [];
    const router = createWhatsAppMessageRouter({
      registry,
      detectors: [throwing, other],
      fallback: async (event) => {
        fallbackCalls.push(event);
      },
      onDetectorError: (name, error) => detectorErrors.push([name, error]),
    });

    await router(waEvent(fakeSocket()));
    await otherRan;

    expect(handled).toEqual(["other"]);
    expect(fallbackCalls).toHaveLength(1);
    expect(detectorErrors).toHaveLength(1);
    expect(detectorErrors[0]?.[0]).toBe("thrower");
  });

  test("parallel detectors fire alongside a matching replace detector, not instead of it", async () => {
    const handled: string[] = [];
    const parallel = parallelDetector("reaction", true, async () => {
      handled.push("reaction");
    });
    const replace = replaceDetector("answer", true, () => handled.push("answer"));

    const { router, fallbackCalls } = createRouter([parallel, replace]);
    await router(waEvent(fakeSocket()));
    // let the fire-and-forget parallel detector's microtask run
    await Promise.resolve();
    await Promise.resolve();

    expect(handled).toContain("answer");
    expect(handled).toContain("reaction");
    expect(fallbackCalls).toHaveLength(0);
  });

  test("a message from the bot's own session is dropped before any detector or the fallback runs", async () => {
    const handled: string[] = [];
    const detectors: MessageDetector[] = [replaceDetector("any", true, () => handled.push("any"))];
    const { router, fallbackCalls } = createRouter(detectors);

    await router(waEvent(fakeSocket(), { key: { remoteJid: "chat@g.us", fromMe: true } }));

    expect(handled).toEqual([]);
    expect(fallbackCalls).toHaveLength(0);
  });

  test("a group chat blocked by the allowlist is dropped before any detector or the fallback runs", async () => {
    const handled: string[] = [];
    const detectors: MessageDetector[] = [replaceDetector("any", true, () => handled.push("any"))];
    const registry: SessionIdentityRegistry = new Map();
    const fallbackCalls: WhatsAppMessageEvent[] = [];
    const router = createWhatsAppMessageRouter({
      registry,
      allowedChats: ["allowed@g.us"],
      detectors,
      fallback: async (event) => {
        fallbackCalls.push(event);
      },
    });

    await router(
      waEvent(fakeSocket(), {
        key: { remoteJid: "unlisted@g.us", fromMe: false, participant: "999@s.whatsapp.net" },
      }),
    );

    expect(handled).toEqual([]);
    expect(fallbackCalls).toHaveLength(0);
  });

  test("an existing single-handler host works unchanged as the fallback", async () => {
    const calls: WhatsAppMessageEvent[] = [];
    const existingHandler = async (event: WhatsAppMessageEvent) => {
      calls.push(event);
    };
    const registry: SessionIdentityRegistry = new Map();
    const router = createWhatsAppMessageRouter({
      registry,
      detectors: [],
      fallback: existingHandler,
    });

    const event = waEvent(fakeSocket());
    await router(event);

    expect(calls).toEqual([event]);
  });

  test("a caption-less photo/voice note in a non-allowlisted group is dropped too, not just text messages", async () => {
    const handled: string[] = [];
    const detectors: MessageDetector[] = [replaceDetector("any", true, () => handled.push("any"))];
    const registry: SessionIdentityRegistry = new Map();
    const fallbackCalls: WhatsAppMessageEvent[] = [];
    const router = createWhatsAppMessageRouter({
      registry,
      allowedChats: ["allowed@g.us"],
      detectors,
      fallback: async (event) => {
        fallbackCalls.push(event);
      },
    });

    await router(
      waEvent(fakeSocket(), {
        key: { remoteJid: "unlisted@g.us", fromMe: false, participant: "999@s.whatsapp.net" },
        message: { imageMessage: {} },
      }),
    );

    expect(handled).toEqual([]);
    expect(fallbackCalls).toHaveLength(0);
  });

  test("a replace detector whose test throws is logged and skipped, and the next detector still gets a chance", async () => {
    const handled: string[] = [];
    const detectorErrors: Array<[string, unknown]> = [];
    const throwing: ReplaceDetector = {
      name: "throws-on-test",
      mode: "replace",
      test: () => {
        throw new Error("test blew up");
      },
      handle: async () => {
        handled.push("throws-on-test");
      },
    };
    const registry: SessionIdentityRegistry = new Map();
    const fallbackCalls: WhatsAppMessageEvent[] = [];
    const router = createWhatsAppMessageRouter({
      registry,
      detectors: [throwing, replaceDetector("next", true, () => handled.push("next"))],
      fallback: async (event) => {
        fallbackCalls.push(event);
      },
      onDetectorError: (name, error) => detectorErrors.push([name, error]),
    });

    await router(waEvent(fakeSocket()));

    expect(handled).toEqual(["next"]);
    expect(fallbackCalls).toHaveLength(0);
    expect(detectorErrors).toEqual([["throws-on-test", expect.any(Error)]]);
  });

  test("a matching replace detector's throwing handle still skips the fallback", async () => {
    const detectorErrors: Array<[string, unknown]> = [];
    const throwing: ReplaceDetector = {
      name: "throws-on-handle",
      mode: "replace",
      test: () => true,
      handle: async () => {
        throw new Error("handle blew up");
      },
    };
    const registry: SessionIdentityRegistry = new Map();
    const fallbackCalls: WhatsAppMessageEvent[] = [];
    const router = createWhatsAppMessageRouter({
      registry,
      detectors: [throwing],
      fallback: async (event) => {
        fallbackCalls.push(event);
      },
      onDetectorError: (name, error) => detectorErrors.push([name, error]),
    });

    await router(waEvent(fakeSocket()));

    expect(fallbackCalls).toHaveLength(0);
    expect(detectorErrors).toEqual([["throws-on-handle", expect.any(Error)]]);
  });

  test("a parallel detector whose test doesn't match never runs its handle", async () => {
    const handled: string[] = [];
    const detectors: MessageDetector[] = [
      parallelDetector("skipped", false, async () => {
        handled.push("skipped");
      }),
    ];
    const { router } = createRouter(detectors);

    await router(waEvent(fakeSocket()));
    await Promise.resolve();
    await Promise.resolve();

    expect(handled).toEqual([]);
  });

  test("a parallel detector that never settles never blocks the fallback", async () => {
    let releaseDetector: () => void = () => {};
    const neverSettlesUntilReleased = new Promise<void>((resolve) => {
      releaseDetector = resolve;
    });
    const detectors: MessageDetector[] = [
      parallelDetector("slow", true, () => neverSettlesUntilReleased),
    ];
    const { router, fallbackCalls } = createRouter(detectors);

    await router(waEvent(fakeSocket()));

    expect(fallbackCalls).toHaveLength(1);
    releaseDetector();
  });

  test("with no onDetectorError configured, a detector failure is logged via the router's logger", async () => {
    const warnCalls: unknown[][] = [];
    const logger: Logger = {
      debug() {},
      info() {},
      warn: (...args) => warnCalls.push(args),
      error() {},
    };
    const throwing: ReplaceDetector = {
      name: "unconfigured-error-detector",
      mode: "replace",
      test: () => true,
      handle: async () => {
        throw new Error("boom");
      },
    };
    const { router } = createRouter([throwing], { logger });

    await router(waEvent(fakeSocket()));

    expect(warnCalls.length).toBeGreaterThan(0);
    expect(String(warnCalls[0]?.[0])).toContain("unconfigured-error-detector");
  });

  test("an async test function is awaited for both modes", async () => {
    const handled: string[] = [];
    const asyncReplace: ReplaceDetector = {
      name: "async-replace",
      mode: "replace",
      test: async () => true,
      handle: async () => {
        handled.push("async-replace");
      },
    };
    const { router, fallbackCalls } = createRouter([asyncReplace]);

    await router(waEvent(fakeSocket()));

    expect(handled).toEqual(["async-replace"]);
    expect(fallbackCalls).toHaveLength(0);
  });

  test("ctx carries the own-mention-stripped text and this session's own ids, resolved once", async () => {
    let seenCtx: WaDetectorContext | undefined;
    const capture: ReplaceDetector = {
      name: "capture",
      mode: "replace",
      test: (ctx) => {
        seenCtx = ctx;
        return false;
      },
      handle: async () => {},
    };
    const { router } = createRouter([capture]);
    const sock = fakeSocket();

    await router(
      waEvent(sock, {
        key: { remoteJid: "447700900123@s.whatsapp.net", fromMe: false },
        message: { extendedTextMessage: { text: "@447700900000 hello", contextInfo: {} } },
      }),
    );

    expect(seenCtx?.text).toBe("hello");
    expect(seenCtx?.ownIds).toEqual(["447700900000@s.whatsapp.net"]);
  });
});
