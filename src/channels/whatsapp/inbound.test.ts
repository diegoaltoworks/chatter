import { describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WAMessage, WASocket } from "@whiskeysockets/baileys";
import type OpenAI from "openai";
import type { PromptLoader } from "../../core/prompts";
import type { VectorStore } from "../../core/retrieval";
import { createPersonaResolver } from "../../personas/resolver";
import type { SessionIdentityRegistry } from "../gates";
import type { WhatsAppMessageEvent } from "./channel";
import {
  createWhatsAppInboundHandler,
  extractText,
  isGroupJid,
  jidsMatch,
  jidToPhoneNumber,
  messageContext,
  senderPhoneFor,
  type WhatsAppInboundConfig,
} from "./inbound";

// --- jid helpers ---

describe("isGroupJid", () => {
  test("group jids end in @g.us", () => {
    expect(isGroupJid("123456-789@g.us")).toBe(true);
    expect(isGroupJid("447700900123@s.whatsapp.net")).toBe(false);
  });
});

describe("jidsMatch", () => {
  test("a device-suffixed jid matches its bare form", () => {
    expect(jidsMatch("447700900123:17@s.whatsapp.net", "447700900123@s.whatsapp.net")).toBe(true);
  });

  test("different numbers do not match", () => {
    expect(jidsMatch("447700900123@s.whatsapp.net", "447700900999@s.whatsapp.net")).toBe(false);
  });

  test("undefined never matches", () => {
    expect(jidsMatch(undefined, "447700900123@s.whatsapp.net")).toBe(false);
    expect(jidsMatch("447700900123@s.whatsapp.net", undefined)).toBe(false);
  });
});

describe("jidToPhoneNumber", () => {
  test("strips the domain and device suffix, adds a leading +", () => {
    expect(jidToPhoneNumber("447700900123:17@s.whatsapp.net")).toBe("+447700900123");
  });

  test("a jid already carrying + is left alone", () => {
    expect(jidToPhoneNumber("+447700900123@s.whatsapp.net")).toBe("+447700900123");
  });
});

function fakeSocket(overrides: Partial<WASocket> = {}): WASocket {
  return {
    user: { id: "447700900000@s.whatsapp.net" },
    sendMessage: mock(async () => undefined),
    ...overrides,
  } as unknown as WASocket;
}

describe("senderPhoneFor", () => {
  test("prefers participantPn over the raw participant jid", async () => {
    const message = {
      key: { participant: "999@lid", participantPn: "447700900123@s.whatsapp.net" },
    } as unknown as WAMessage;

    const phone = await senderPhoneFor(fakeSocket(), message, "chat@g.us");

    expect(phone).toBe("+447700900123");
  });

  test("falls back to the chat jid for a DM with no participant", async () => {
    const message = { key: {} } as unknown as WAMessage;

    const phone = await senderPhoneFor(fakeSocket(), message, "447700900123@s.whatsapp.net");

    expect(phone).toBe("+447700900123");
  });

  test("an empty-string participant (LID-addressed DM quirk) is skipped, not kept", async () => {
    const message = { key: { participant: "" } } as unknown as WAMessage;

    const phone = await senderPhoneFor(fakeSocket(), message, "447700900123@s.whatsapp.net");

    expect(phone).toBe("+447700900123");
  });

  test("resolves a LID sender through the socket's mapping store", async () => {
    const message = { key: { participant: "999@lid" } } as unknown as WAMessage;
    const sock = fakeSocket({
      signalRepository: {
        lidMapping: { getPNForLID: async () => "447700900123@s.whatsapp.net" },
      },
    } as never);

    const phone = await senderPhoneFor(sock, message, "chat@g.us");

    expect(phone).toBe("+447700900123");
  });

  test("a failing LID lookup returns an explicit lid: marker, not a fabricated phone number", async () => {
    const message = { key: { participant: "999@lid" } } as unknown as WAMessage;
    const sock = fakeSocket({
      signalRepository: {
        lidMapping: {
          getPNForLID: async () => {
            throw new Error("boom");
          },
        },
      },
    } as never);

    const phone = await senderPhoneFor(sock, message, "chat@g.us");

    expect(phone).toBe("lid:999");
  });

  test("an unmapped LID (no lidMapping at all) also returns the lid: marker", async () => {
    const message = { key: { participant: "999@lid" } } as unknown as WAMessage;

    const phone = await senderPhoneFor(fakeSocket(), message, "chat@g.us");

    expect(phone).toBe("lid:999");
  });
});

// --- message-shape helpers ---

describe("extractText", () => {
  test("plain conversation text", () => {
    const message = { message: { conversation: "hello" } } as unknown as WAMessage;
    expect(extractText(message)).toBe("hello");
  });

  test("extended text (quoted/mentions) message", () => {
    const message = {
      message: { extendedTextMessage: { text: "hi there" } },
    } as unknown as WAMessage;
    expect(extractText(message)).toBe("hi there");
  });

  test("image caption", () => {
    const message = {
      message: { imageMessage: { caption: "look at this" } },
    } as unknown as WAMessage;
    expect(extractText(message)).toBe("look at this");
  });

  test("video caption", () => {
    const message = {
      message: { videoMessage: { caption: "watch this" } },
    } as unknown as WAMessage;
    expect(extractText(message)).toBe("watch this");
  });

  test("document caption", () => {
    const message = {
      message: { documentMessage: { caption: "see attached" } },
    } as unknown as WAMessage;
    expect(extractText(message)).toBe("see attached");
  });

  test("no message content -> empty string", () => {
    const message = {} as unknown as WAMessage;
    expect(extractText(message)).toBe("");
  });
});

describe("messageContext", () => {
  test("mentions on an extended text message", () => {
    const message = {
      message: {
        extendedTextMessage: {
          text: "@bot hi",
          contextInfo: { mentionedJid: ["bot@s.whatsapp.net"] },
        },
      },
    } as unknown as WAMessage;

    expect(messageContext(message)).toEqual({
      mentionedJids: ["bot@s.whatsapp.net"],
      quotedParticipantJid: undefined,
    });
  });

  // Regression: mentions/quoted-reply info in a photo caption live on
  // imageMessage.contextInfo, NOT extendedTextMessage — missing this made
  // mentions in photo captions invisible.
  test("mentions on an image caption", () => {
    const message = {
      message: {
        imageMessage: {
          caption: "@bot look",
          contextInfo: { mentionedJid: ["bot@s.whatsapp.net"] },
        },
      },
    } as unknown as WAMessage;

    expect(messageContext(message).mentionedJids).toEqual(["bot@s.whatsapp.net"]);
  });

  test("mentions on a video caption", () => {
    const message = {
      message: {
        videoMessage: {
          caption: "@bot watch",
          contextInfo: { mentionedJid: ["bot@s.whatsapp.net"] },
        },
      },
    } as unknown as WAMessage;

    expect(messageContext(message).mentionedJids).toEqual(["bot@s.whatsapp.net"]);
  });

  test("mentions on a document caption", () => {
    const message = {
      message: {
        documentMessage: {
          caption: "@bot see",
          contextInfo: { mentionedJid: ["bot@s.whatsapp.net"] },
        },
      },
    } as unknown as WAMessage;

    expect(messageContext(message).mentionedJids).toEqual(["bot@s.whatsapp.net"]);
  });

  test("quoted participant carries through", () => {
    const message = {
      message: {
        extendedTextMessage: {
          text: "yes",
          contextInfo: { participant: "bot@s.whatsapp.net" },
        },
      },
    } as unknown as WAMessage;

    expect(messageContext(message).quotedParticipantJid).toBe("bot@s.whatsapp.net");
  });

  test("no contextInfo -> empty mentions, no quoted participant", () => {
    const message = { message: { conversation: "hi" } } as unknown as WAMessage;
    expect(messageContext(message)).toEqual({ mentionedJids: [], quotedParticipantJid: undefined });
  });
});

// --- createWhatsAppInboundHandler ---

interface Harness {
  handler: (event: WhatsAppMessageEvent) => Promise<void>;
  sock: WASocket & { sendMessage: ReturnType<typeof mock> };
  registry: SessionIdentityRegistry;
  answerCalls: unknown[];
}

function createHarness(overrides: Partial<WhatsAppInboundConfig> = {}): Harness {
  const registry: SessionIdentityRegistry = overrides.registry ?? new Map();
  const answerCalls: unknown[] = [];

  const store = { query: async () => ["some context"] } as unknown as VectorStore;
  const prompts = {
    baseSystemRules: "rules",
    publicPersona: "persona",
    privatePersona: "private persona",
  } as unknown as PromptLoader;

  const config: WhatsAppInboundConfig = {
    client: {} as unknown as OpenAI,
    store,
    prompts,
    registry,
    answerFn: async (input) => {
      answerCalls.push(input);
      return "a reply";
    },
    ...overrides,
  };

  const handler = createWhatsAppInboundHandler(config);
  const sock = fakeSocket() as WASocket & { sendMessage: ReturnType<typeof mock> };

  return { handler, sock, registry, answerCalls };
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

describe("createWhatsAppInboundHandler", () => {
  test("a DM is answered through prepareChat/answerFn and replied to, quoted", async () => {
    const { handler, sock, answerCalls } = createHarness();

    await handler(waEvent(sock));

    expect(answerCalls).toHaveLength(1);
    expect(sock.sendMessage).toHaveBeenCalledWith(
      "447700900123@s.whatsapp.net",
      { text: "a reply" },
      { quoted: expect.anything() },
    );
  });

  test("status@broadcast is skipped", async () => {
    const { handler, sock, answerCalls } = createHarness();

    await handler(waEvent(sock, { key: { remoteJid: "status@broadcast", fromMe: false } }));

    expect(answerCalls).toHaveLength(0);
    expect(sock.sendMessage).not.toHaveBeenCalled();
  });

  test("an empty text message is skipped", async () => {
    const { handler, sock, answerCalls } = createHarness();

    await handler(waEvent(sock, { message: { conversation: "" } }));

    expect(answerCalls).toHaveLength(0);
  });

  test("an unaddressed group message is ignored", async () => {
    const { handler, sock, answerCalls } = createHarness();

    await handler(
      waEvent(sock, {
        key: { remoteJid: "group@g.us", participant: "447700900999@s.whatsapp.net", fromMe: false },
        message: { conversation: "just chatting" },
      }),
    );

    expect(answerCalls).toHaveLength(0);
    expect(sock.sendMessage).not.toHaveBeenCalled();
  });

  test("a group message that @-mentions the bot's own jid gets a reply", async () => {
    const { handler, sock, answerCalls } = createHarness();

    await handler(
      waEvent(sock, {
        key: { remoteJid: "group@g.us", participant: "447700900999@s.whatsapp.net", fromMe: false },
        message: {
          extendedTextMessage: {
            text: "@bot hi",
            contextInfo: { mentionedJid: ["447700900000@s.whatsapp.net"] },
          },
        },
      }),
    );

    expect(answerCalls).toHaveLength(1);
  });

  test("mute/unmute regexes flip the group's mute state without answering", async () => {
    const { handler, sock, answerCalls } = createHarness({
      muteRegex: /shut up/i,
      unmuteRegex: /wake up/i,
      muteReply: "ok",
      unmuteReply: "back",
    });
    const groupMsg = (text: string) =>
      waEvent(sock, {
        key: { remoteJid: "group@g.us", participant: "447700900999@s.whatsapp.net", fromMe: false },
        message: {
          extendedTextMessage: {
            text,
            contextInfo: { mentionedJid: ["447700900000@s.whatsapp.net"] },
          },
        },
      });

    await handler(groupMsg("@bot shut up"));
    expect(sock.sendMessage).toHaveBeenCalledWith("group@g.us", { text: "ok" });

    // Muted now: an addressed message gets no reply at all.
    await handler(groupMsg("@bot you there"));
    expect(answerCalls).toHaveLength(0);

    await handler(groupMsg("@bot wake up"));
    expect(sock.sendMessage).toHaveBeenCalledWith("group@g.us", { text: "back" });

    await handler(groupMsg("@bot you there"));
    expect(answerCalls).toHaveLength(1);
  });

  // Cross-session loop guard: a second session's own number must be treated
  // as fromBot by the first session's handler, or two linked numbers in one
  // process reply to each other forever.
  test("a message from another registered session's own identity is treated as fromBot", async () => {
    const registry: SessionIdentityRegistry = new Map([
      ["other-session", ["447700900999@s.whatsapp.net"]],
    ]);
    const { handler, sock, answerCalls } = createHarness({ registry });

    await handler(
      waEvent(sock, {
        key: {
          remoteJid: "447700900999@s.whatsapp.net",
          participant: "447700900999@s.whatsapp.net",
          fromMe: false,
        },
      }),
    );

    expect(answerCalls).toHaveLength(0);
  });

  // Regression: Baileys reports sock.user.id WITH a device suffix
  // ("...:12@domain"), while the very same number arrives on another
  // session's socket as a bare participant jid. One shared handler serves
  // both sessions (the documented usage pattern): "other-session" writes
  // its own identity into the registry first, then "default" receives a
  // message from that bare number and must recognize it as itself.
  test("a device-suffixed own identity (as Baileys reports sock.user.id) still matches the bare form on another session", async () => {
    const { handler, answerCalls } = createHarness();

    const otherSock = fakeSocket({ user: { id: "447700900999:12@s.whatsapp.net" } } as never);
    await handler({
      sessionId: "other-session",
      sock: otherSock,
      message: {
        key: { remoteJid: "someone-else@s.whatsapp.net", fromMe: false },
        message: { conversation: "hi" },
      } as unknown as WAMessage,
    });
    answerCalls.length = 0;

    await handler({
      sessionId: "default",
      sock: fakeSocket(),
      message: {
        key: {
          remoteJid: "447700900999@s.whatsapp.net",
          participant: "447700900999@s.whatsapp.net",
          fromMe: false,
        },
        message: { conversation: "hello" },
      } as unknown as WAMessage,
    });

    expect(answerCalls).toHaveLength(0);
  });

  test("the handler's own session identity is synced into the registry from sock.user on every message", async () => {
    const registry: SessionIdentityRegistry = new Map();
    const { handler, sock } = createHarness({ registry });

    await handler(waEvent(sock));

    expect(registry.get("default")).toEqual(["447700900000@s.whatsapp.net"]);
  });

  test("a device-suffixed sock.user.id is normalized before it's stored in the registry", async () => {
    const registry: SessionIdentityRegistry = new Map();
    const { handler, sock } = createHarness({ registry });
    sock.user = { id: "447700900000:12@s.whatsapp.net" } as never;

    await handler(waEvent(sock));

    expect(registry.get("default")).toEqual(["447700900000@s.whatsapp.net"]);
  });

  test("allowedChats restricts groups to the allowlist; unlisted groups are ignored even when addressed", async () => {
    const { handler, sock, answerCalls } = createHarness({ allowedChats: ["allowed@g.us"] });
    const groupMsg = (chatId: string) =>
      waEvent(sock, {
        key: { remoteJid: chatId, participant: "447700900999@s.whatsapp.net", fromMe: false },
        message: {
          extendedTextMessage: {
            text: "@bot hi",
            contextInfo: { mentionedJid: ["447700900000@s.whatsapp.net"] },
          },
        },
      });

    await handler(groupMsg("unlisted@g.us"));
    expect(answerCalls).toHaveLength(0);

    await handler(groupMsg("allowed@g.us"));
    expect(answerCalls).toHaveLength(1);
  });

  test("allowedChats has no effect on DMs, which always reply", async () => {
    const { handler, sock, answerCalls } = createHarness({ allowedChats: ["some-group@g.us"] });

    await handler(waEvent(sock));

    expect(answerCalls).toHaveLength(1);
  });

  test("group rate limiting is tracked separately from the DM budget", async () => {
    const { handler, sock, answerCalls } = createHarness({
      groupRateLimit: { max: 1, windowMs: 60_000 },
    });
    const groupMsg = () =>
      waEvent(sock, {
        key: { remoteJid: "group@g.us", participant: "447700900999@s.whatsapp.net", fromMe: false },
        message: {
          extendedTextMessage: {
            text: "@bot hi",
            contextInfo: { mentionedJid: ["447700900000@s.whatsapp.net"] },
          },
        },
      });

    await handler(groupMsg());
    await handler(groupMsg());
    expect(answerCalls).toHaveLength(1);

    // The DM budget is untouched by the group flood above.
    await handler(waEvent(sock));
    expect(answerCalls).toHaveLength(2);
  });

  test("bucketsFor, channelHint and the resolved sender all reach prepareChat/answerFn", async () => {
    const queries: unknown[] = [];
    const store = {
      query: async (_q: string, _k: number, buckets: string[]) => {
        queries.push(buckets);
        return ["context"];
      },
    } as unknown as VectorStore;
    let capturedInput: { system: string; sender?: string } | undefined;

    const { handler, sock } = createHarness({
      store,
      bucketsFor: () => ["base", "public", "extra"],
      channelHint: "Channel: WhatsApp.",
      answerFn: async (input) => {
        capturedInput = input;
        return "ok";
      },
    });

    await handler(waEvent(sock));

    expect(queries).toEqual([["base", "public", "extra"]]);
    expect(capturedInput?.system).toContain("Channel: WhatsApp.");
    expect(capturedInput?.sender).toBe("+447700900123");
  });

  test("a personaResolver's output feeds prepareChat's personaLayer", async () => {
    let capturedSystem = "";
    const { handler, sock } = createHarness({
      answerFn: async (input) => {
        capturedSystem = input.system;
        return "ok";
      },
      personaResolver: async () => "you are a pirate",
    });

    await handler(waEvent(sock));

    expect(capturedSystem).toContain("you are a pirate");
  });

  test("a real createPersonaResolver wired as personaResolver reaches prepareChat's system prompt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "inbound-personas-"));
    try {
      writeFileSync(join(dir, "alt.txt"), "you are the registry-configured alt persona", "utf-8");
      const resolver = createPersonaResolver({
        promptsDir: dir,
        registry: {
          defaultPersona: "alt",
          personas: { alt: { name: "Alt", prompt: "alt.txt" } },
        },
      });

      let capturedSystem = "";
      const { handler, sock } = createHarness({
        answerFn: async (input) => {
          capturedSystem = input.system;
          return "ok";
        },
        personaResolver: ({ senderPhone }) =>
          resolver.resolvePersonaLayer(senderPhone) ?? undefined,
      });

      await handler(waEvent(sock));

      expect(capturedSystem).toContain("you are the registry-configured alt persona");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a throwing personaResolver degrades to no persona instead of failing the reply", async () => {
    const { handler, sock, answerCalls } = createHarness({
      personaResolver: async () => {
        throw new Error("registry unavailable");
      },
    });

    await handler(waEvent(sock));

    expect(answerCalls).toHaveLength(1);
  });

  test("an images handler that reports it handled the message short-circuits before chat runs", async () => {
    const imagesCalls: unknown[] = [];
    const { handler, sock, answerCalls } = createHarness({
      images: async (ctx) => {
        imagesCalls.push(ctx);
        return true;
      },
    });

    await handler(waEvent(sock));

    expect(imagesCalls).toEqual([
      {
        sock,
        message: expect.anything(),
        chatId: "447700900123@s.whatsapp.net",
        senderId: "+447700900123",
        text: "hello there",
        hasPhoto: false,
      },
    ]);
    expect(answerCalls).toHaveLength(0);
    expect(sock.sendMessage).not.toHaveBeenCalled();
  });

  test("an images handler that reports it did not handle the message falls through to normal chat", async () => {
    const { handler, sock, answerCalls } = createHarness({ images: async () => false });

    await handler(waEvent(sock));

    expect(answerCalls).toHaveLength(1);
  });

  test("hasPhoto reflects an attached imageMessage on the raw Baileys message", async () => {
    const imagesCalls: Array<{ hasPhoto: boolean }> = [];
    const { handler, sock } = createHarness({
      images: async (ctx) => {
        imagesCalls.push(ctx);
        return true;
      },
    });

    await handler(waEvent(sock, { message: { imageMessage: { caption: "draw me here" } } }));

    expect(imagesCalls[0]?.hasPhoto).toBe(true);
  });

  test("rate limiting drops replies past the configured budget without throwing", async () => {
    const { handler, sock, answerCalls } = createHarness({
      dmRateLimit: { max: 1, windowMs: 60_000 },
    });

    await handler(waEvent(sock));
    await handler(waEvent(sock));

    expect(answerCalls).toHaveLength(1);
    expect(sock.sendMessage).toHaveBeenCalledTimes(1);
  });

  test("a throwing answerFn is caught and logged, never left to reject", async () => {
    const { handler, sock } = createHarness({
      answerFn: async () => {
        throw new Error("brain unavailable");
      },
    });

    await expect(handler(waEvent(sock))).resolves.toBeUndefined();
    expect(sock.sendMessage).not.toHaveBeenCalled();
  });

  test("a throwing sendMessage (reply delivery) is caught and logged, never left to reject", async () => {
    const { handler, sock } = createHarness();
    sock.sendMessage = mock(async () => {
      throw new Error("socket closed");
    });

    await expect(handler(waEvent(sock))).resolves.toBeUndefined();
  });
});
