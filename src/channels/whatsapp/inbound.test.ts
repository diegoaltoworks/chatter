import { describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WAMessage, WASocket } from "@whiskeysockets/baileys";
import type OpenAI from "openai";
import type { AnswerFnInput } from "../../core/answer";
import type { Logger } from "../../core/logger";
import type { PromptLoader } from "../../core/prompts";
import type { VectorStore } from "../../core/retrieval";
import type { HistoryMessage, HistoryStore } from "../../history/types";
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
  stripOwnMentions,
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

describe("stripOwnMentions", () => {
  const own = ["447700900000@s.whatsapp.net"];

  test("the bot's own mention token is removed", () => {
    expect(stripOwnMentions("@447700900000 say hello", own)).toBe("say hello");
  });

  test("another participant's mention is left alone", () => {
    expect(stripOwnMentions("@447700900999 are you there?", own)).toBe(
      "@447700900999 are you there?",
    );
  });

  test("only the bot's token goes when both are mentioned", () => {
    expect(stripOwnMentions("@447700900000 tell @447700900999 I'm late", own)).toBe(
      "tell @447700900999 I'm late",
    );
  });

  test("text with no mentions passes through unchanged", () => {
    expect(stripOwnMentions("what's the weather like?", own)).toBe("what's the weather like?");
  });

  test("a device-suffixed or LID own id still matches its token", () => {
    expect(stripOwnMentions("@447700900000 hi", ["447700900000:17@s.whatsapp.net"])).toBe("hi");
    expect(stripOwnMentions("@259841343885518 hi", ["259841343885518@lid"])).toBe("hi");
  });

  test("a token in the middle of a sentence collapses its surrounding spaces", () => {
    expect(stripOwnMentions("hey @447700900000 what's up", own)).toBe("hey what's up");
  });

  // The strip must not double as a formatter: everything but the bot's own
  // token comes through byte-for-byte, or a pasted code snippet loses its
  // indentation on the way to the model.
  test("indentation and blank lines around the mention survive", () => {
    expect(
      stripOwnMentions("@447700900000 review this:\n\n    def foo():\n        return 1", own),
    ).toBe("review this:\n\n    def foo():\n        return 1");
  });

  test("a message with no own mention is returned byte-identical", () => {
    const text = "  spaced   out\n\tand indented  ";
    expect(stripOwnMentions(text, own)).toBe(text);
  });

  test("an address that merely contains the bot's digits is not a mention", () => {
    expect(stripOwnMentions("mail me at bob@447700900000.com", own)).toBe(
      "mail me at bob@447700900000.com",
    );
  });

  test("a mention on its own line keeps the following lines", () => {
    expect(stripOwnMentions("@447700900000\nsummarise this:\n- one", own)).toBe(
      "summarise this:\n- one",
    );
  });

  // An empty user message fails retrieval instead of producing a reply, so a
  // mention-only message keeps its original text rather than becoming "".
  test("a mention-only message is returned unchanged", () => {
    expect(stripOwnMentions("@447700900000", own)).toBe("@447700900000");
  });

  test("no own ids known -> nothing is stripped", () => {
    expect(stripOwnMentions("@447700900000 hi", [])).toBe("@447700900000 hi");
  });

  test("a longer number that merely starts with the bot's digits is not a match", () => {
    expect(stripOwnMentions("@4477009000001 hi", own)).toBe("@4477009000001 hi");
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

function fakeLogger(): { logger: Logger; warnCalls: unknown[][]; allCalls: unknown[][] } {
  const warnCalls: unknown[][] = [];
  const allCalls: unknown[][] = [];
  return {
    logger: {
      debug: (...args) => allCalls.push(args),
      info: (...args) => allCalls.push(args),
      warn: (...args) => {
        warnCalls.push(args);
        allCalls.push(args);
      },
      error: (...args) => allCalls.push(args),
    },
    warnCalls,
    allCalls,
  };
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

  // Regression (exact field shape from the reported case): the bot was
  // correctly detected as mentioned, then handed the literal mention token as
  // the user's message and answered by asking what "@259841343885518" meant.
  test("the bot's own mention token never reaches the model", async () => {
    const sock = fakeSocket({
      user: { id: "259841343885518:12@s.whatsapp.net" },
    } as unknown as Partial<WASocket>) as WASocket & { sendMessage: ReturnType<typeof mock> };
    const answerCalls: AnswerFnInput[] = [];
    const handler = createWhatsAppInboundHandler({
      client: {} as unknown as OpenAI,
      store: { query: async () => ["some context"] } as unknown as VectorStore,
      prompts: {
        baseSystemRules: "rules",
        publicPersona: "persona",
        privatePersona: "private persona",
      } as unknown as PromptLoader,
      registry: new Map(),
      answerFn: async (input) => {
        answerCalls.push(input);
        return "a reply";
      },
    });

    await handler(
      waEvent(sock, {
        key: { remoteJid: "group@g.us", participant: "447700900999@s.whatsapp.net", fromMe: false },
        message: {
          extendedTextMessage: {
            text: "@259841343885518 say hello",
            contextInfo: { mentionedJid: ["259841343885518@s.whatsapp.net"] },
          },
        },
      }),
    );

    expect(answerCalls).toHaveLength(1);
    expect(answerCalls[0]?.messages).toEqual([{ role: "user", content: "say hello" }]);
  });

  test("another participant's mention survives into the model's message", async () => {
    const { handler, sock, answerCalls } = createHarness();

    await handler(
      waEvent(sock, {
        key: { remoteJid: "group@g.us", participant: "447700900999@s.whatsapp.net", fromMe: false },
        message: {
          extendedTextMessage: {
            text: "@447700900000 tell @447700900888 I'm late",
            contextInfo: {
              mentionedJid: ["447700900000@s.whatsapp.net", "447700900888@s.whatsapp.net"],
            },
          },
        },
      }),
    );

    expect((answerCalls[0] as AnswerFnInput | undefined)?.messages).toEqual([
      { role: "user", content: "tell @447700900888 I'm late" },
    ]);
  });

  // The cleaned text is what the gates see too, so a host's anchored mute
  // pattern fires on an addressed command instead of missing it.
  test("an anchored mute regex matches a mention-prefixed command", async () => {
    const { handler, sock, answerCalls } = createHarness({
      muteRegex: /^go quiet$/i,
      muteReply: "ok",
    });

    await handler(
      waEvent(sock, {
        key: { remoteJid: "group@g.us", participant: "447700900999@s.whatsapp.net", fromMe: false },
        message: {
          extendedTextMessage: {
            text: "@447700900000 go quiet",
            contextInfo: { mentionedJid: ["447700900000@s.whatsapp.net"] },
          },
        },
      }),
    );

    expect(sock.sendMessage).toHaveBeenCalledWith("group@g.us", { text: "ok" });
    expect(answerCalls).toHaveLength(0);
  });

  // Stripping a mention-only message to "" would make the gates drop it as
  // blank; being addressed and going silent is worse than answering a bare
  // ping, so the original text stands.
  test("a mention-only message is still answered", async () => {
    const { handler, sock, answerCalls } = createHarness();

    await handler(
      waEvent(sock, {
        key: { remoteJid: "group@g.us", participant: "447700900999@s.whatsapp.net", fromMe: false },
        message: {
          extendedTextMessage: {
            text: "@447700900000",
            contextInfo: { mentionedJid: ["447700900000@s.whatsapp.net"] },
          },
        },
      }),
    );

    expect(answerCalls).toHaveLength(1);
  });

  test("a DM with no mentions reaches the model unchanged", async () => {
    const { handler, sock, answerCalls } = createHarness();

    await handler(waEvent(sock));

    expect((answerCalls[0] as AnswerFnInput | undefined)?.messages).toEqual([
      { role: "user", content: "hello there" },
    ]);
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

  /** An addressed group message, for allowlist-logging tests below. */
  const addressedGroupMsg = (sock: WASocket, chatId: string) =>
    waEvent(sock, {
      key: { remoteJid: chatId, participant: "447700900999@s.whatsapp.net", fromMe: false },
      message: {
        extendedTextMessage: {
          text: "@bot hi",
          contextInfo: { mentionedJid: ["447700900000@s.whatsapp.net"] },
        },
      },
    });

  test("a group rejected by allowedChats logs its jid, without changing the ignore decision", async () => {
    const { logger, warnCalls } = fakeLogger();
    const { handler, sock, answerCalls } = createHarness({
      allowedChats: ["allowed@g.us"],
      logger,
    });

    await handler(addressedGroupMsg(sock, "unlisted@g.us"));

    expect(answerCalls).toHaveLength(0);
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0]?.[0]).toContain("unlisted@g.us");
    expect(warnCalls[0]?.[0]).toContain("not in allowedChats");
  });

  test("DMs and allowlisted groups log nothing new", async () => {
    const { logger, allCalls } = fakeLogger();
    const { handler, sock } = createHarness({ allowedChats: ["allowed@g.us"], logger });

    await handler(waEvent(sock)); // DM
    await handler(addressedGroupMsg(sock, "allowed@g.us"));

    expect(allCalls).toHaveLength(0);
  });

  test("an unaddressed group with no allowlist configured logs nothing (ignored for a different reason)", async () => {
    const { logger, allCalls } = fakeLogger();
    const { handler, sock } = createHarness({ logger });

    await handler(
      waEvent(sock, {
        key: {
          remoteJid: "any-group@g.us",
          participant: "447700900999@s.whatsapp.net",
          fromMe: false,
        },
        message: { conversation: "just chatting" },
      }),
    );

    expect(allCalls).toHaveLength(0);
  });

  test("a muted allowlisted group logs nothing (ignored for a different reason)", async () => {
    const { logger, allCalls } = fakeLogger();
    const { handler, sock } = createHarness({
      allowedChats: ["allowed@g.us"],
      muteRegex: /shush/i,
      logger,
    });

    await handler(
      waEvent(sock, {
        key: {
          remoteJid: "allowed@g.us",
          participant: "447700900999@s.whatsapp.net",
          fromMe: false,
        },
        message: { extendedTextMessage: { text: "shush", contextInfo: {} } },
      }),
    );
    allCalls.length = 0;

    await handler(addressedGroupMsg(sock, "allowed@g.us"));

    expect(allCalls).toHaveLength(0);
  });

  test("repeated messages from the same rejected chat log only once", async () => {
    const { logger, warnCalls } = fakeLogger();
    const { handler, sock } = createHarness({ allowedChats: ["allowed@g.us"], logger });

    await handler(addressedGroupMsg(sock, "unlisted@g.us"));
    await handler(addressedGroupMsg(sock, "unlisted@g.us"));
    await handler(addressedGroupMsg(sock, "unlisted@g.us"));

    expect(warnCalls).toHaveLength(1);
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
    let capturedInput: { system: string; sender?: string; conversationId?: string } | undefined;

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
    // The chat JID is a stable per-conversation key, handed to the brain so
    // it can key threads/history without WhatsApp-specific knowledge.
    expect(capturedInput?.conversationId).toBe("447700900123@s.whatsapp.net");
  });

  test("rewriteQuery reshapes the retrieval query and sees the resolved sender", async () => {
    const queries: string[] = [];
    const store = {
      query: async (q: string) => {
        queries.push(q);
        return ["context"];
      },
    } as unknown as VectorStore;
    const seen: unknown[] = [];

    const { handler, sock } = createHarness({
      store,
      rewriteQuery: (ctx) => {
        seen.push(ctx);
        return `expanded: ${ctx.query}`;
      },
    });

    await handler(waEvent(sock));

    expect(queries).toEqual(["expanded: hello there"]);
    expect(seen).toEqual([{ query: "hello there", mode: "public", sender: "+447700900123" }]);
  });

  test("rerankContext reorders the chunks folded into the assembled system prompt", async () => {
    const store = { query: async () => ["first", "second"] } as unknown as VectorStore;
    let capturedSystem = "";

    const { handler, sock } = createHarness({
      store,
      rerankContext: async ({ chunks }) => [...chunks].reverse(),
      answerFn: async (input) => {
        capturedSystem = input.system;
        return "ok";
      },
    });

    await handler(waEvent(sock));

    expect(capturedSystem).toContain("second\n\nfirst");
  });

  test("a throwing rewriteQuery is logged and retrieval falls back to the unmodified query", async () => {
    const queries: string[] = [];
    const store = {
      query: async (q: string) => {
        queries.push(q);
        return ["context"];
      },
    } as unknown as VectorStore;
    const { logger, allCalls } = fakeLogger();

    const { handler, sock, answerCalls } = createHarness({
      store,
      logger,
      rewriteQuery: () => {
        throw new Error("boom");
      },
    });

    await handler(waEvent(sock));

    expect(queries).toEqual(["hello there"]);
    expect(answerCalls).toHaveLength(1);
    expect(allCalls.some((args) => String(args[0]).includes("rewriteQuery"))).toBe(true);
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

  function fakeHistoryStore(): HistoryStore & { data: Map<string, HistoryMessage[]> } {
    const data = new Map<string, HistoryMessage[]>();
    return {
      data,
      async append(conversationId, message) {
        const turns = data.get(conversationId) ?? [];
        turns.push(message);
        data.set(conversationId, turns);
      },
      async load(conversationId, limit) {
        return (data.get(conversationId) ?? []).slice(-limit);
      },
    };
  }

  describe("conversation history", () => {
    test("with no history configured, only the latest message reaches answerFn", async () => {
      const { handler, sock, answerCalls } = createHarness();

      await handler(waEvent(sock));

      expect((answerCalls[0] as AnswerFnInput).messages).toEqual([
        { role: "user", content: "hello there" },
      ]);
    });

    test("prior turns are loaded ahead of the new message when history is configured", async () => {
      const store = fakeHistoryStore();
      await store.append("447700900123@s.whatsapp.net", { role: "user", content: "earlier" });
      await store.append("447700900123@s.whatsapp.net", {
        role: "assistant",
        content: "earlier reply",
      });
      const { handler, sock, answerCalls } = createHarness({ history: { store } });

      await handler(waEvent(sock));

      expect((answerCalls[0] as AnswerFnInput).messages).toEqual([
        { role: "user", content: "earlier" },
        { role: "assistant", content: "earlier reply" },
        { role: "user", content: "hello there" },
      ]);
    });

    test("the user turn then the assistant turn are appended, in order", async () => {
      const store = fakeHistoryStore();
      const { handler, sock } = createHarness({ history: { store } });

      await handler(waEvent(sock));

      expect(store.data.get("447700900123@s.whatsapp.net")).toEqual([
        { role: "user", content: "hello there" },
        { role: "assistant", content: "a reply" },
      ]);
    });

    // The user's turn is recorded before the brain even runs, so a failure
    // downstream never erases it from history.
    test("a throwing answerFn still leaves the user's turn recorded", async () => {
      const store = fakeHistoryStore();
      const { handler, sock } = createHarness({
        history: { store },
        answerFn: async () => {
          throw new Error("brain unavailable");
        },
      });

      await handler(waEvent(sock));

      expect(store.data.get("447700900123@s.whatsapp.net")).toEqual([
        { role: "user", content: "hello there" },
      ]);
    });

    // The assistant's turn is recorded as soon as it exists, before delivery
    // is attempted, so a failed send never erases an answer that was given.
    test("a throwing sendMessage still leaves both turns recorded", async () => {
      const store = fakeHistoryStore();
      const { handler, sock } = createHarness({ history: { store } });
      sock.sendMessage = mock(async () => {
        throw new Error("socket closed");
      });

      await handler(waEvent(sock));

      expect(store.data.get("447700900123@s.whatsapp.net")).toEqual([
        { role: "user", content: "hello there" },
        { role: "assistant", content: "a reply" },
      ]);
    });

    test("an empty answer still records the user's turn but not an assistant one", async () => {
      const store = fakeHistoryStore();
      const { handler, sock } = createHarness({ history: { store }, answerFn: async () => "" });

      await handler(waEvent(sock));

      expect(store.data.get("447700900123@s.whatsapp.net")).toEqual([
        { role: "user", content: "hello there" },
      ]);
    });

    test("limit bounds how many prior turns are loaded", async () => {
      const store = fakeHistoryStore();
      for (let i = 0; i < 5; i++) {
        await store.append("447700900123@s.whatsapp.net", { role: "user", content: `turn ${i}` });
      }
      const { handler, sock, answerCalls } = createHarness({ history: { store, limit: 2 } });

      await handler(waEvent(sock));

      expect((answerCalls[0] as AnswerFnInput).messages).toEqual([
        { role: "user", content: "turn 3" },
        { role: "user", content: "turn 4" },
        { role: "user", content: "hello there" },
      ]);
    });
  });

  describe("transformReply hook", () => {
    test('sees the channel identity as "whatsapp"', async () => {
      const seen: string[] = [];
      const { handler, sock } = createHarness({
        transformReply: (ctx) => {
          seen.push(ctx.channel);
          return ctx.text;
        },
      });

      await handler(waEvent(sock));

      expect(seen).toEqual(["whatsapp"]);
    });

    test("a string result replaces the delivered reply", async () => {
      const { handler, sock } = createHarness({ transformReply: () => "transformed" });

      await handler(waEvent(sock));

      expect(sock.sendMessage).toHaveBeenCalledWith(
        "447700900123@s.whatsapp.net",
        { text: "transformed" },
        { quoted: expect.anything() },
      );
    });

    test("null vetoes the reply: nothing is sent", async () => {
      const { handler, sock } = createHarness({ transformReply: () => null });

      await handler(waEvent(sock));

      expect(sock.sendMessage).not.toHaveBeenCalled();
    });

    test("a throwing transformReply is logged and the original reply is delivered", async () => {
      const { logger, allCalls } = fakeLogger();
      const { handler, sock } = createHarness({
        transformReply: () => {
          throw new Error("plugin bug");
        },
        logger,
      });

      await handler(waEvent(sock));

      expect(sock.sendMessage).toHaveBeenCalledWith(
        "447700900123@s.whatsapp.net",
        { text: "a reply" },
        { quoted: expect.anything() },
      );
      expect(allCalls.some((call) => String(call[0]).includes("transformReply"))).toBe(true);
    });
  });
});
