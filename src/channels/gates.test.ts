import { describe, expect, test } from "bun:test";
import {
  type ChannelGateConfig,
  type ChannelMessage,
  createSlidingWindowRateLimiter,
  decideChannelAction,
  isEffectivelyFromSelf,
  isFromAnySession,
  type SessionIdentityRegistry,
  underReplyRateLimit,
} from "./gates";

function msg(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    chatId: "chat-1",
    senderId: "user-1",
    text: "hello",
    isDirectMessage: false,
    mentionsBot: false,
    isReplyToBot: false,
    fromBot: false,
    ...overrides,
  };
}

function config(overrides: Partial<ChannelGateConfig> = {}): ChannelGateConfig {
  return {
    allowedChats: [],
    mutedChats: new Set(),
    ...overrides,
  };
}

describe("decideChannelAction", () => {
  test("ignores messages from the bot itself", () => {
    expect(decideChannelAction(msg({ fromBot: true, isDirectMessage: true }), config())).toBe(
      "ignore",
    );
  });

  test("ignores blank text", () => {
    expect(decideChannelAction(msg({ text: "   ", isDirectMessage: true }), config())).toBe(
      "ignore",
    );
  });

  test("DMs always reply, unaddressed", () => {
    expect(decideChannelAction(msg({ isDirectMessage: true, mentionsBot: false }), config())).toBe(
      "reply",
    );
  });

  test("groups ignore unaddressed messages", () => {
    expect(decideChannelAction(msg({ isDirectMessage: false }), config())).toBe("ignore");
  });

  test("groups reply when mentioned", () => {
    expect(decideChannelAction(msg({ isDirectMessage: false, mentionsBot: true }), config())).toBe(
      "reply",
    );
  });

  test("groups reply when replying to the bot", () => {
    expect(decideChannelAction(msg({ isDirectMessage: false, isReplyToBot: true }), config())).toBe(
      "reply",
    );
  });

  test("empty allowlist means every group is eligible", () => {
    expect(
      decideChannelAction(
        msg({ isDirectMessage: false, mentionsBot: true, chatId: "any-chat" }),
        config({ allowedChats: [] }),
      ),
    ).toBe("reply");
  });

  test("non-empty allowlist restricts to listed chats", () => {
    const cfg = config({ allowedChats: ["chat-allowed"] });
    expect(
      decideChannelAction(
        msg({ isDirectMessage: false, mentionsBot: true, chatId: "chat-other" }),
        cfg,
      ),
    ).toBe("ignore");
    expect(
      decideChannelAction(
        msg({ isDirectMessage: false, mentionsBot: true, chatId: "chat-allowed" }),
        cfg,
      ),
    ).toBe("reply");
  });

  test("DMs bypass the allowlist entirely", () => {
    expect(
      decideChannelAction(
        msg({ isDirectMessage: true, chatId: "not-allowlisted" }),
        config({ allowedChats: ["some-other-chat"] }),
      ),
    ).toBe("reply");
  });

  test("a muted chat ignores addressed messages", () => {
    expect(
      decideChannelAction(
        msg({ isDirectMessage: false, mentionsBot: true, chatId: "chat-1" }),
        config({ mutedChats: new Set(["chat-1"]) }),
      ),
    ).toBe("ignore");
  });

  test("no mute/unmute regex configured means those triggers never fire", () => {
    expect(
      decideChannelAction(msg({ isDirectMessage: false, text: "please be quiet" }), config()),
    ).toBe("ignore");
  });

  test("caller-configured mute regex triggers mute even when already muted", () => {
    const cfg = config({
      mutedChats: new Set(),
      muteRegex: /shut up/i,
    });
    expect(decideChannelAction(msg({ isDirectMessage: false, text: "bot, shut up" }), cfg)).toBe(
      "mute",
    );
  });

  test("caller-configured unmute regex triggers unmute even in a muted chat", () => {
    const cfg = config({
      mutedChats: new Set(["chat-1"]),
      unmuteRegex: /wake up/i,
    });
    expect(decideChannelAction(msg({ isDirectMessage: false, text: "bot, wake up" }), cfg)).toBe(
      "unmute",
    );
  });

  test("mute/unmute checks respect the allowlist", () => {
    const cfg = config({
      allowedChats: ["chat-allowed"],
      muteRegex: /shut up/i,
    });
    expect(
      decideChannelAction(
        msg({ isDirectMessage: false, text: "shut up", chatId: "chat-other" }),
        cfg,
      ),
    ).toBe("ignore");
  });

  test("mute wins when a message matches both the mute and unmute regex", () => {
    const cfg = config({
      muteRegex: /bot/i,
      unmuteRegex: /bot/i,
    });
    expect(decideChannelAction(msg({ isDirectMessage: false, text: "bot" }), cfg)).toBe("mute");
  });

  test("mute/unmute and the muted set never apply to DMs", () => {
    const cfg = config({
      mutedChats: new Set(["chat-1"]),
      muteRegex: /shut up/i,
    });
    expect(
      decideChannelAction(msg({ isDirectMessage: true, chatId: "chat-1", text: "shut up" }), cfg),
    ).toBe("reply");
  });

  test("a global/sticky mute regex does not misfire on alternating calls due to lastIndex state", () => {
    const cfg = config({ muteRegex: /shut up/gi });
    const first = msg({ isDirectMessage: false, text: "shut up" });

    expect(decideChannelAction(first, cfg)).toBe("mute");
    expect(decideChannelAction(first, cfg)).toBe("mute");
  });
});

describe("createSlidingWindowRateLimiter", () => {
  test("allows up to the max within a window", () => {
    const now = 0;
    const allow = createSlidingWindowRateLimiter(2, 1000, () => now);

    expect(allow("a")).toBe(true);
    expect(allow("a")).toBe(true);
    expect(allow("a")).toBe(false);
  });

  test("tracks each key independently", () => {
    const now = 0;
    const allow = createSlidingWindowRateLimiter(1, 1000, () => now);

    expect(allow("a")).toBe(true);
    expect(allow("b")).toBe(true);
  });

  test("expired entries fall out of the window, freeing capacity", () => {
    let now = 0;
    const allow = createSlidingWindowRateLimiter(1, 1000, () => now);

    expect(allow("a")).toBe(true);
    expect(allow("a")).toBe(false);

    now = 1001;

    expect(allow("a")).toBe(true);
  });

  test("defaults to Date.now when no clock is injected", () => {
    const allow = createSlidingWindowRateLimiter(1, 1000);
    expect(allow("a")).toBe(true);
  });
});

describe("underReplyRateLimit", () => {
  test("routes DMs to the dm limiter and groups to the group limiter", () => {
    const dmCalls: string[] = [];
    const groupCalls: string[] = [];
    const limiters = {
      dm: (chatId: string) => {
        dmCalls.push(chatId);
        return true;
      },
      group: (chatId: string) => {
        groupCalls.push(chatId);
        return true;
      },
    };

    underReplyRateLimit({ chatId: "dm-1", isDirectMessage: true }, limiters);
    underReplyRateLimit({ chatId: "group-1", isDirectMessage: false }, limiters);

    expect(dmCalls).toEqual(["dm-1"]);
    expect(groupCalls).toEqual(["group-1"]);
  });

  test("a flood on one budget cannot spend the other's", () => {
    const now = 0;
    const dmAllow = createSlidingWindowRateLimiter(1, 1000, () => now);
    const groupAllow = createSlidingWindowRateLimiter(1, 1000, () => now);
    const limiters = { dm: dmAllow, group: groupAllow };

    expect(underReplyRateLimit({ chatId: "dm-1", isDirectMessage: true }, limiters)).toBe(true);
    expect(underReplyRateLimit({ chatId: "dm-1", isDirectMessage: true }, limiters)).toBe(false);
    expect(underReplyRateLimit({ chatId: "group-1", isDirectMessage: false }, limiters)).toBe(true);
  });
});

describe("isFromAnySession / isEffectivelyFromSelf", () => {
  test("matches an identity registered under any session", () => {
    const registry: SessionIdentityRegistry = new Map([
      ["session-a", ["id-a1", "id-a2"]],
      ["session-b", ["id-b1"]],
    ]);

    expect(isFromAnySession("id-b1", registry)).toBe(true);
    expect(isFromAnySession("id-a2", registry)).toBe(true);
    expect(isFromAnySession("stranger", registry)).toBe(false);
  });

  test("undefined id never matches", () => {
    const registry: SessionIdentityRegistry = new Map([["session-a", ["id-a1"]]]);
    expect(isFromAnySession(undefined, registry)).toBe(false);
  });

  test("cross-session loop guard: session B's own identity is caught even though the message arrived on session A", () => {
    const registry: SessionIdentityRegistry = new Map([
      ["session-a", ["id-a1"]],
      ["session-b", ["id-b1"]],
    ]);

    expect(isEffectivelyFromSelf({ fromBot: false, senderId: "id-b1" }, registry)).toBe(true);
  });

  test("the transport's own fromBot flag is honoured without needing a registry match", () => {
    const registry: SessionIdentityRegistry = new Map();
    expect(isEffectivelyFromSelf({ fromBot: true, senderId: "anyone" }, registry)).toBe(true);
  });

  test("a stranger with fromBot false matches neither the flag nor the registry", () => {
    const registry: SessionIdentityRegistry = new Map([["session-a", ["id-a1"]]]);
    expect(isEffectivelyFromSelf({ fromBot: false, senderId: "stranger" }, registry)).toBe(false);
  });

  test("a session's identity is still recognised through a disconnect that never clears it", () => {
    // The guard exists specifically for the disconnect/reconnect window: a
    // session's own identity must stay "us" while it flaps, so callers are
    // documented to never delete a session's entry on disconnect. Model that
    // here by registering once and never touching the registry again before
    // a message from that identity arrives.
    const registry: SessionIdentityRegistry = new Map();
    registry.set("session-a", ["id-a1"]); // connect

    // ...session-a disconnects here; nothing calls registry.delete("session-a")...

    expect(isEffectivelyFromSelf({ fromBot: false, senderId: "id-a1" }, registry)).toBe(true);
  });
});
