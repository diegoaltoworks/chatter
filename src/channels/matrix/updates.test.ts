import { describe, expect, test } from "bun:test";
import { decideChannelAction } from "../gates";
import type { MatrixAccountDataEvent, MatrixEvent, MatrixInvitedRoom } from "./api";
import {
  directInviteFrom,
  directMappingFromEvents,
  directMappingRooms,
  directRoomIds,
  isReplyToBot,
  MAX_TRACKED_SENT_EVENTS,
  matrixSenderKey,
  mentionsBot,
  messageText,
  recordSentEventId,
  toChannelMessage,
  toDirectMapping,
  withDirectRoom,
} from "./updates";

const ME = { userId: "@bot:example.org" };

function event(
  overrides: Partial<MatrixEvent> & { content?: Record<string, unknown> },
): MatrixEvent {
  return {
    type: "m.room.message",
    event_id: "$1",
    sender: "@alice:example.org",
    origin_server_ts: 1,
    content: { msgtype: "m.text", body: "hi" },
    ...overrides,
  } as MatrixEvent;
}

describe("messageText", () => {
  test("reads the body", () => {
    expect(messageText({ body: "hello" })).toBe("hello");
  });

  test("empty for content with no body", () => {
    expect(messageText({})).toBe("");
  });
});

describe("mentionsBot", () => {
  test("matches an m.mentions user id", () => {
    const content = { body: "hey", "m.mentions": { user_ids: ["@bot:example.org"] } };
    expect(mentionsBot(content, ME)).toBe(true);
  });

  test("does not match another user's mention", () => {
    const content = { body: "hey", "m.mentions": { user_ids: ["@other:example.org"] } };
    expect(mentionsBot(content, ME)).toBe(false);
  });

  test("matches a matrix.to pill in formatted_body when m.mentions is absent", () => {
    const content = {
      body: "hey bot",
      formatted_body: 'hey <a href="https://matrix.to/#/@bot:example.org">Bot</a>',
    };
    expect(mentionsBot(content, ME)).toBe(true);
  });

  test("matches a single-quoted pill href too", () => {
    const content = {
      body: "hey bot",
      formatted_body: "hey <a href='https://matrix.to/#/@bot:example.org'>Bot</a>",
    };
    expect(mentionsBot(content, ME)).toBe(true);
  });

  test("matches a percent-encoded pill (the matrix.to spec's own recommended form)", () => {
    const content = {
      body: "hey bot",
      formatted_body: 'hey <a href="https://matrix.to/#/%40bot%3Aexample.org">Bot</a>',
    };
    expect(mentionsBot(content, ME)).toBe(true);
  });

  test("matches a pill carrying a via routing hint", () => {
    const content = {
      body: "hey bot",
      formatted_body: 'hey <a href="https://matrix.to/#/@bot:example.org?via=example.org">Bot</a>',
    };
    expect(mentionsBot(content, ME)).toBe(true);
  });

  test("does not match another user's pill", () => {
    const content = {
      body: "hey someone else",
      formatted_body: 'hey <a href="https://matrix.to/#/@other:example.org">Other</a>',
    };
    expect(mentionsBot(content, ME)).toBe(false);
  });

  test("the bot's id in plain prose, with no mention structure, is not an invitation", () => {
    const content = { body: "@bot:example.org is useless" };
    expect(mentionsBot(content, ME)).toBe(false);
  });

  test("no mentions and no formatted_body at all", () => {
    expect(mentionsBot({ body: "hi" }, ME)).toBe(false);
  });
});

describe("isReplyToBot", () => {
  test("true when the relates_to event id is one we sent", () => {
    const sent = new Set(["$mine"]);
    const content = { body: "and?", "m.relates_to": { "m.in_reply_to": { event_id: "$mine" } } };
    expect(isReplyToBot(content, sent)).toBe(true);
  });

  test("false when replying to someone else's message", () => {
    const sent = new Set(["$mine"]);
    const content = { body: "and?", "m.relates_to": { "m.in_reply_to": { event_id: "$theirs" } } };
    expect(isReplyToBot(content, sent)).toBe(false);
  });

  test("false with no relates_to at all", () => {
    expect(isReplyToBot({ body: "hi" }, new Set())).toBe(false);
  });
});

describe("recordSentEventId", () => {
  test("tracks up to the cap, evicting the oldest first", () => {
    const sent = new Set<string>();
    for (let i = 0; i < MAX_TRACKED_SENT_EVENTS + 10; i++) {
      recordSentEventId(sent, `$${i}`);
    }
    expect(sent.size).toBe(MAX_TRACKED_SENT_EVENTS);
    expect(sent.has("$0")).toBe(false);
    expect(sent.has(`$${MAX_TRACKED_SENT_EVENTS + 9}`)).toBe(true);
  });
});

describe("directRoomIds", () => {
  test("collects every room across every peer in m.direct", () => {
    const events: MatrixAccountDataEvent[] = [
      {
        type: "m.direct",
        content: {
          "@alice:example.org": ["!a:example.org"],
          "@bob:example.org": ["!b:example.org", "!c:example.org"],
        },
      },
    ];
    expect(directRoomIds(events)).toEqual(
      new Set(["!a:example.org", "!b:example.org", "!c:example.org"]),
    );
  });

  test("empty when there is no m.direct account data event", () => {
    expect(directRoomIds([])).toEqual(new Set());
  });
});

describe("m.direct mapping", () => {
  test("toDirectMapping keeps peer -> rooms and drops anything else the account data holds", () => {
    expect(
      toDirectMapping({
        "@alice:example.org": ["!a:example.org"],
        "@bob:example.org": [],
        "@carol:example.org": "not-an-array",
        "@dave:example.org": ["!d:example.org", 7],
      }),
    ).toEqual({
      "@alice:example.org": ["!a:example.org"],
      "@dave:example.org": ["!d:example.org"],
    });
  });

  test("directMappingFromEvents is undefined for a batch that says nothing about m.direct", () => {
    const events: MatrixAccountDataEvent[] = [{ type: "m.push_rules", content: {} }];
    expect(directMappingFromEvents(events)).toBeUndefined();
  });

  test("directMappingFromEvents reads the m.direct document out of the batch", () => {
    const events: MatrixAccountDataEvent[] = [
      { type: "m.push_rules", content: {} },
      { type: "m.direct", content: { "@alice:example.org": ["!a:example.org"] } },
    ];
    expect(directMappingFromEvents(events)).toEqual({ "@alice:example.org": ["!a:example.org"] });
    expect(directMappingRooms(directMappingFromEvents(events) as Record<string, string[]>)).toEqual(
      new Set(["!a:example.org"]),
    );
  });

  test("withDirectRoom appends without mutating the original", () => {
    const mapping = { "@alice:example.org": ["!a:example.org"] };
    expect(withDirectRoom(mapping, "@alice:example.org", "!b:example.org")).toEqual({
      "@alice:example.org": ["!a:example.org", "!b:example.org"],
    });
    expect(withDirectRoom(mapping, "@bob:example.org", "!c:example.org")).toEqual({
      "@alice:example.org": ["!a:example.org"],
      "@bob:example.org": ["!c:example.org"],
    });
    expect(mapping).toEqual({ "@alice:example.org": ["!a:example.org"] });
  });

  test("withDirectRoom is undefined when the room is already recorded, so nothing is written", () => {
    expect(
      withDirectRoom(
        { "@alice:example.org": ["!a:example.org"] },
        "@alice:example.org",
        "!a:example.org",
      ),
    ).toBeUndefined();
  });
});

describe("directInviteFrom", () => {
  /** An invite as `/sync` delivers it: stripped state events, no event ids, no timestamps. */
  function invite(botMemberContent: Record<string, unknown>): MatrixInvitedRoom {
    return {
      invite_state: {
        events: [
          {
            type: "m.room.create",
            state_key: "",
            sender: "@alice:example.org",
            content: { creator: "@alice:example.org", room_version: "10" },
          },
          {
            type: "m.room.member",
            state_key: "@alice:example.org",
            sender: "@alice:example.org",
            content: { membership: "join", displayname: "Alice" },
          },
          {
            type: "m.room.member",
            state_key: "@bot:example.org",
            sender: "@alice:example.org",
            content: botMemberContent,
          },
        ],
      },
    };
  }

  test("returns the inviter for an is_direct invite addressed to the bot", () => {
    expect(directInviteFrom(invite({ membership: "invite", is_direct: true }), ME)).toBe(
      "@alice:example.org",
    );
  });

  test("undefined for an ordinary room invite", () => {
    expect(directInviteFrom(invite({ membership: "invite" }), ME)).toBeUndefined();
  });

  test("undefined when the is_direct member event is for somebody else", () => {
    const room: MatrixInvitedRoom = {
      invite_state: {
        events: [
          {
            type: "m.room.member",
            state_key: "@other:example.org",
            sender: "@alice:example.org",
            content: { membership: "invite", is_direct: true },
          },
        ],
      },
    };
    expect(directInviteFrom(room, ME)).toBeUndefined();
  });

  test("undefined for an invite with no state at all", () => {
    expect(directInviteFrom({}, ME)).toBeUndefined();
  });
});

describe("toChannelMessage", () => {
  test("maps a group message into the channel shape", () => {
    const msg = toChannelMessage(
      "!room:example.org",
      event({
        content: {
          msgtype: "m.text",
          body: "@Bot hello",
          "m.mentions": { user_ids: ["@bot:example.org"] },
        },
      }),
      ME,
      new Set(),
      new Set(),
    );

    expect(msg).toEqual({
      chatId: "!room:example.org",
      senderId: "@alice:example.org",
      text: "@Bot hello",
      isDirectMessage: false,
      mentionsBot: true,
      isReplyToBot: false,
      fromBot: false,
      messageRef: "$1",
    });
  });

  test("a room listed in m.direct is a direct message", () => {
    const msg = toChannelMessage(
      "!dm:example.org",
      event({}),
      ME,
      new Set(["!dm:example.org"]),
      new Set(),
    );
    expect(msg?.isDirectMessage).toBe(true);
  });

  test("a room absent from m.direct is a group", () => {
    const msg = toChannelMessage("!room:example.org", event({}), ME, new Set(), new Set());
    expect(msg?.isDirectMessage).toBe(false);
  });

  test("the bot's own message is flagged fromBot (loop guard)", () => {
    const msg = toChannelMessage(
      "!room:example.org",
      event({ sender: "@bot:example.org" }),
      ME,
      new Set(),
      new Set(),
    );
    expect(msg?.fromBot).toBe(true);
  });

  test("a non-message event maps to nothing", () => {
    expect(
      toChannelMessage(
        "!room:example.org",
        event({ type: "m.room.member" }),
        ME,
        new Set(),
        new Set(),
      ),
    ).toBeUndefined();
  });

  test("an encrypted event maps to nothing (unsupported, not decryptable)", () => {
    expect(
      toChannelMessage(
        "!room:example.org",
        event({ type: "m.room.encrypted", content: { algorithm: "m.megolm.v1.aes-sha2" } }),
        ME,
        new Set(),
        new Set(),
      ),
    ).toBeUndefined();
  });

  test("an edit (m.replace) maps to nothing, so the original answer is not repeated", () => {
    expect(
      toChannelMessage(
        "!room:example.org",
        event({
          event_id: "$edit",
          content: {
            msgtype: "m.text",
            body: "* @Bot what time is it",
            "m.mentions": { user_ids: ["@bot:example.org"] },
            "m.new_content": { msgtype: "m.text", body: "@Bot what time is it" },
            "m.relates_to": { rel_type: "m.replace", event_id: "$1" },
          },
        }),
        ME,
        new Set(),
        new Set(),
      ),
    ).toBeUndefined();
  });

  test("a plain reply (no rel_type) is still a message", () => {
    const msg = toChannelMessage(
      "!room:example.org",
      event({
        content: {
          msgtype: "m.text",
          body: "and again?",
          "m.relates_to": { "m.in_reply_to": { event_id: "$mine" } },
        },
      }),
      ME,
      new Set(),
      new Set(["$mine"]),
    );
    expect(msg?.isReplyToBot).toBe(true);
  });

  test("a redacted message (no msgtype) maps to nothing", () => {
    expect(
      toChannelMessage("!room:example.org", event({ content: {} }), ME, new Set(), new Set()),
    ).toBeUndefined();
  });
});

describe("gating parity with the other channels", () => {
  const gates = { allowedChats: [], mutedChats: new Set<string>() };
  const decide = (roomId: string, e: MatrixEvent, direct: Set<string>) => {
    const msg = toChannelMessage(roomId, e, ME, direct, new Set());
    return msg ? decideChannelAction(msg, gates) : "ignore";
  };

  test("an unaddressed group message is ignored", () => {
    expect(
      decide(
        "!room:example.org",
        event({ content: { msgtype: "m.text", body: "lunch soon?" } }),
        new Set(),
      ),
    ).toBe("ignore");
  });

  test("an addressed group message replies", () => {
    expect(
      decide(
        "!room:example.org",
        event({
          content: {
            msgtype: "m.text",
            body: "@Bot lunch?",
            "m.mentions": { user_ids: ["@bot:example.org"] },
          },
        }),
        new Set(),
      ),
    ).toBe("reply");
  });

  test("an unaddressed direct message still replies", () => {
    expect(
      decide(
        "!dm:example.org",
        event({ content: { msgtype: "m.text", body: "hi" } }),
        new Set(["!dm:example.org"]),
      ),
    ).toBe("reply");
  });
});

describe("matrixSenderKey", () => {
  test("namespaces the user id", () => {
    expect(matrixSenderKey("@alice:example.org")).toBe("mx:@alice:example.org");
  });
});
