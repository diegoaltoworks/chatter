import { describe, expect, test } from "bun:test";
import { decideChannelAction, type SessionIdentityRegistry } from "../gates";
import type { TelegramMessage, TelegramUpdate } from "./api";
import {
  mentionsBot,
  messageEntities,
  messageText,
  nextOffset,
  type TelegramBotIdentity,
  telegramOwnIdentities,
  telegramSenderKey,
  toChannelMessage,
} from "./updates";

const ME: TelegramBotIdentity = { id: 100, username: "MyBot" };

function update(message: Partial<TelegramMessage> & { chat?: Partial<TelegramMessage["chat"]> }) {
  return {
    update_id: 1,
    message: {
      message_id: 55,
      from: { id: 200 },
      chat: { id: -4242, type: "supergroup", ...message.chat },
      ...message,
    },
  } as TelegramUpdate;
}

describe("messageText / messageEntities", () => {
  test("reads a plain text message and its entities", () => {
    const message = {
      text: "hi",
      entities: [{ type: "mention", offset: 0, length: 2 }],
      caption_entities: [{ type: "mention", offset: 9, length: 9 }],
    } as TelegramMessage;
    expect(messageText(message)).toBe("hi");
    expect(messageEntities(message)).toEqual([{ type: "mention", offset: 0, length: 2 }]);
  });

  test("reads a caption and its caption_entities when there is no text", () => {
    const message = {
      caption: "look @MyBot",
      caption_entities: [{ type: "mention", offset: 5, length: 6 }],
    } as TelegramMessage;
    expect(messageText(message)).toBe("look @MyBot");
    expect(messageEntities(message)).toEqual([{ type: "mention", offset: 5, length: 6 }]);
  });

  test("empty for a message carrying neither", () => {
    expect(messageText({} as TelegramMessage)).toBe("");
    expect(messageEntities({} as TelegramMessage)).toEqual([]);
  });
});

describe("mentionsBot", () => {
  test("matches an @username mention entity, case-insensitively", () => {
    const message = {
      text: "hey @mybot what's up",
      entities: [{ type: "mention", offset: 4, length: 6 }],
    } as TelegramMessage;
    expect(mentionsBot(message, ME)).toBe(true);
  });

  test("does not match another bot's mention", () => {
    const message = {
      text: "hey @otherbot",
      entities: [{ type: "mention", offset: 4, length: 9 }],
    } as TelegramMessage;
    expect(mentionsBot(message, ME)).toBe(false);
  });

  test("matches a text_mention entity by user id (bot with no username)", () => {
    const message = {
      text: "hey you",
      entities: [{ type: "text_mention", offset: 4, length: 3, user: { id: 100 } }],
    } as TelegramMessage;
    expect(mentionsBot(message, { id: 100 })).toBe(true);
  });

  test("matches a username-suffixed bot command, the group disambiguation form", () => {
    const message = {
      text: "/ask@MyBot when is lunch",
      entities: [{ type: "bot_command", offset: 0, length: 10 }],
    } as TelegramMessage;
    expect(mentionsBot(message, ME)).toBe(true);
  });

  test("does not match a bare command, which every bot in the group receives", () => {
    const message = {
      text: "/ask when is lunch",
      entities: [{ type: "bot_command", offset: 0, length: 4 }],
    } as TelegramMessage;
    expect(mentionsBot(message, ME)).toBe(false);
  });

  test("matches a mention inside a photo caption", () => {
    const message = {
      caption: "@MyBot what is this",
      caption_entities: [{ type: "mention", offset: 0, length: 6 }],
    } as TelegramMessage;
    expect(mentionsBot(message, ME)).toBe(true);
  });

  test("the bot's name in prose, with no entity, is not an invitation", () => {
    const message = { text: "MyBot is useless" } as TelegramMessage;
    expect(mentionsBot(message, ME)).toBe(false);
  });
});

describe("toChannelMessage", () => {
  test("maps a group message into the channel shape", () => {
    const msg = toChannelMessage(
      update({
        text: "@MyBot hello",
        entities: [{ type: "mention", offset: 0, length: 6 }],
      }),
      ME,
    );

    expect(msg).toEqual({
      chatId: "-4242",
      senderId: "200",
      text: "@MyBot hello",
      isDirectMessage: false,
      mentionsBot: true,
      isReplyToBot: false,
      fromBot: false,
      messageRef: 55,
    });
  });

  test("a private chat is a direct message", () => {
    const msg = toChannelMessage(update({ text: "hi", chat: { id: 200, type: "private" } }), ME);
    expect(msg?.isDirectMessage).toBe(true);
  });

  test("a reply to one of the bot's own messages counts as addressed", () => {
    const msg = toChannelMessage(
      update({ text: "and the other one?", reply_to_message: { from: { id: 100 } } }),
      ME,
    );
    expect(msg?.isReplyToBot).toBe(true);
  });

  test("a reply to somebody else is not addressed", () => {
    const msg = toChannelMessage(
      update({ text: "yeah", reply_to_message: { from: { id: 300 } } }),
      ME,
    );
    expect(msg?.isReplyToBot).toBe(false);
  });

  test("the bot's own message is flagged fromBot (loop guard)", () => {
    const msg = toChannelMessage(update({ text: "my own answer", from: { id: 100 } }), ME);
    expect(msg?.fromBot).toBe(true);
  });

  test("a sibling bot in the same process is fromBot, not a stranger", () => {
    // The loop this prevents: two bot tokens mounted in one process, each a
    // stranger to the other's `me`, answering each other's answers forever.
    const identities: SessionIdentityRegistry = new Map([
      ["telegram", telegramOwnIdentities(ME)],
      ["telegram:support", telegramOwnIdentities({ id: 900, username: "SupportBot" })],
    ]);

    const msg = toChannelMessage(
      update({ text: "the other persona's answer", from: { id: 900 } }),
      ME,
      identities,
    );

    expect(msg?.fromBot).toBe(true);
  });

  test("a stranger is still a stranger with the registry populated", () => {
    const identities: SessionIdentityRegistry = new Map([
      ["telegram:support", telegramOwnIdentities({ id: 900 })],
    ]);

    const msg = toChannelMessage(update({ text: "hello?", from: { id: 200 } }), ME, identities);

    expect(msg?.fromBot).toBe(false);
  });

  test("only the numeric id is registered: senderId is never the @username", () => {
    expect(telegramOwnIdentities(ME)).toEqual(["100"]);
  });

  test("a non-message update and a channel post (no `from`) map to nothing", () => {
    expect(toChannelMessage({ update_id: 9 }, ME)).toBeUndefined();
    expect(
      toChannelMessage(
        {
          update_id: 9,
          message: { message_id: 1, chat: { id: 1, type: "channel" }, text: "post" },
        },
        ME,
      ),
    ).toBeUndefined();
  });

  test("an uncaptioned photo maps with blank text, which the gates drop", () => {
    const msg = toChannelMessage(update({}), ME);
    expect(msg?.text).toBe("");
  });
});

describe("gating parity with WhatsApp semantics", () => {
  const gates = { allowedChats: [], mutedChats: new Set<string>() };
  const decide = (u: TelegramUpdate) => {
    const msg = toChannelMessage(u, ME);
    return msg ? decideChannelAction(msg, gates) : "ignore";
  };

  test("an unaddressed group message is ignored", () => {
    expect(decide(update({ text: "lunch soon?" }))).toBe("ignore");
  });

  test("an addressed group message replies", () => {
    expect(
      decide(
        update({ text: "@MyBot lunch?", entities: [{ type: "mention", offset: 0, length: 6 }] }),
      ),
    ).toBe("reply");
  });

  test("a reply to the bot in a group replies", () => {
    expect(decide(update({ text: "and?", reply_to_message: { from: { id: 100 } } }))).toBe("reply");
  });

  test("an unaddressed DM still replies", () => {
    expect(decide(update({ text: "hi", chat: { id: 200, type: "private" } }))).toBe("reply");
  });

  test("the bot's own group message is ignored", () => {
    expect(
      decide(
        update({
          text: "@MyBot hello",
          from: { id: 100 },
          entities: [{ type: "mention", offset: 0, length: 6 }],
        }),
      ),
    ).toBe("ignore");
  });

  test("an allowlisted-out group is ignored even when addressed", () => {
    const msg = toChannelMessage(
      update({ text: "@MyBot hi", entities: [{ type: "mention", offset: 0, length: 6 }] }),
      ME,
    );
    expect(
      decideChannelAction(msg as NonNullable<typeof msg>, {
        allowedChats: ["-1"],
        mutedChats: new Set(),
      }),
    ).toBe("ignore");
  });
});

describe("offsets and identity keys", () => {
  test("nextOffset acknowledges the update it is given", () => {
    expect(nextOffset({ update_id: 41 })).toBe(42);
  });

  test("the sender key is namespaced, never a bare numeral", () => {
    expect(telegramSenderKey("200")).toBe("tg:200");
  });
});
