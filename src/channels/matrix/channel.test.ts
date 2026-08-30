import { describe, expect, test } from "bun:test";
import type { Logger } from "../../core/logger";
import type { PromptLoader } from "../../core/prompts";
import type { Retriever } from "../../core/retrieval";
import type { ChatterConfig, ServerDependencies } from "../../types";
import { createSenderRegistry } from "../senders";
import type { MatrixApi, MatrixEvent, MatrixInvitedRoom, MatrixSyncResponse } from "./api";
import { createMatrixChannel, type MatrixChannelConfig } from "./channel";

const ME = "@bot:example.org";

interface FakeApi extends MatrixApi {
  sent: Array<{ roomId: string; content: Record<string, unknown> }>;
  media: Array<{ roomId: string; payload: unknown }>;
  joins: string[];
  syncs: Array<string | undefined>;
  signals: Array<AbortSignal | undefined>;
  accountDataWrites: Array<{ userId: string; type: string; content: Record<string, unknown> }>;
}

/** A homeserver that serves one scripted batch of sync responses and then hangs — no network, no token. */
function fakeApi(
  batches: MatrixSyncResponse[],
  options: {
    whoamiFails?: boolean;
    /** The bot account's stored `m.direct` document, exactly as `GET /account_data/m.direct` returns it. */
    accountData?: Record<string, unknown>;
    accountDataWriteFails?: boolean;
  } = {},
): FakeApi {
  const sent: FakeApi["sent"] = [];
  const media: FakeApi["media"] = [];
  const joins: FakeApi["joins"] = [];
  const syncs: FakeApi["syncs"] = [];
  const signals: FakeApi["signals"] = [];
  const accountDataWrites: FakeApi["accountDataWrites"] = [];
  let round = 0;
  let eventCounter = 0;

  return {
    sent,
    media,
    joins,
    syncs,
    signals,
    accountDataWrites,
    call: async () => undefined as never,
    whoami: async () => {
      if (options.whoamiFails) throw new Error("M_UNKNOWN_TOKEN");
      return { userId: ME };
    },
    sync: ({ since, signal }) => {
      syncs.push(since);
      signals.push(signal);
      const batch = batches[round++];
      // Past the script, hold the request open like a real long poll instead
      // of resolving forever — a test that spun that loop would starve the
      // pipeline work it is waiting on.
      return batch ? Promise.resolve(batch) : new Promise<MatrixSyncResponse>(() => undefined);
    },
    sendEvent: async (roomId, content) => {
      sent.push({ roomId, content });
      eventCounter += 1;
      return { eventId: `$sent-${eventCounter}` };
    },
    uploadMedia: async () => ({ contentUri: "mxc://example.org/uploaded" }),
    sendMedia: async (roomId, payload) => {
      media.push({ roomId, payload });
      eventCounter += 1;
      return { eventId: `$media-${eventCounter}` };
    },
    joinRoom: async (roomId) => {
      joins.push(roomId);
    },
    getAccountData: async () => options.accountData as never,
    setAccountData: async (userId, type, content) => {
      if (options.accountDataWriteFails) throw new Error("M_FORBIDDEN");
      accountDataWrites.push({ userId, type, content });
    },
  };
}

function silentLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  const record = (...args: unknown[]) => {
    lines.push(String(args[0]));
  };
  return { lines, debug: record, info: record, warn: record, error: record };
}

function fakeDeps(
  logger: Logger,
  configOverrides: Partial<ChatterConfig> = {},
): ServerDependencies & { answered: string[] } {
  const answered: string[] = [];
  return {
    answered,
    client: {} as ServerDependencies["client"],
    db: {} as ServerDependencies["db"],
    store: { query: async () => ["context"] } satisfies Retriever,
    prompts: {
      baseSystemRules: "rules",
      publicPersona: "persona",
      privatePersona: "private",
    } as unknown as PromptLoader,
    config: {
      answerFn: async (input: { messages: Array<{ content: string }> }) => {
        answered.push(input.messages.at(-1)?.content ?? "");
        return "the answer";
      },
      ...configOverrides,
    } as unknown as ServerDependencies["config"],
    senders: createSenderRegistry(logger),
    identities: new Map<string, string[]>(),
    logger,
  };
}

function roomEvent(
  overrides: Partial<MatrixEvent> & { content?: Record<string, unknown> } = {},
): MatrixEvent {
  return {
    type: "m.room.message",
    event_id: "$1",
    sender: "@alice:example.org",
    origin_server_ts: 1,
    content: {
      msgtype: "m.text",
      body: "@Bot hello",
      "m.mentions": { user_ids: [ME] },
    },
    ...overrides,
  } as MatrixEvent;
}

function syncWithRoomMessages(
  roomId: string,
  events: MatrixEvent[],
  extra: Partial<MatrixSyncResponse> = {},
): MatrixSyncResponse {
  return {
    next_batch: "s1",
    rooms: { join: { [roomId]: { timeline: { events } } } },
    ...extra,
  };
}

/**
 * An invite exactly as `/sync` delivers one: stripped state events with no
 * event id or timestamp, the room's creation and join rules, and the bot's
 * own `m.room.member` carrying `is_direct` when the inviting client opened a
 * DM. This is the only place a homeserver ever tells a bot a room is a DM.
 */
function invitedRoom(options: { inviter?: string; isDirect?: boolean } = {}): MatrixInvitedRoom {
  const inviter = options.inviter ?? "@alice:example.org";
  return {
    invite_state: {
      events: [
        {
          type: "m.room.create",
          state_key: "",
          sender: inviter,
          content: { creator: inviter, room_version: "10" },
        },
        {
          type: "m.room.join_rules",
          state_key: "",
          sender: inviter,
          content: { join_rule: "invite" },
        },
        {
          type: "m.room.member",
          state_key: inviter,
          sender: inviter,
          content: { membership: "join", displayname: "Alice" },
        },
        {
          type: "m.room.member",
          state_key: ME,
          sender: inviter,
          content: {
            membership: "invite",
            displayname: "bot",
            ...(options.isDirect ? { is_direct: true } : {}),
          },
        },
      ],
    },
  };
}

/** Lets the sync loop fetch its scripted batch and run the pipeline to completion. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

/** Runs the channel over one scripted batch and stops it, so no timer or sync outlives the test. */
async function runChannel(
  batches: MatrixSyncResponse[],
  config: Partial<MatrixChannelConfig> = {},
): Promise<{
  api: FakeApi;
  deps: ReturnType<typeof fakeDeps>;
  logger: Logger & { lines: string[] };
}> {
  const api = fakeApi(batches);
  const logger = silentLogger();
  const deps = fakeDeps(logger);
  const channel = createMatrixChannel({
    homeserverUrl: "https://example.org",
    accessToken: "test-token",
    api,
    sleep: async () => undefined,
    logger,
    ...config,
  });

  await channel.start(deps);
  await settle();
  await channel.stop?.();
  return { api, deps, logger };
}

describe("createMatrixChannel", () => {
  test("answers an addressed group message, threaded onto it", async () => {
    const { api, deps } = await runChannel([
      syncWithRoomMessages("!room:example.org", [roomEvent()]),
    ]);

    expect(deps.answered).toEqual(["@Bot hello"]);
    expect(api.sent).toEqual([
      {
        roomId: "!room:example.org",
        content: {
          msgtype: "m.text",
          body: "the answer",
          "m.relates_to": { "m.in_reply_to": { event_id: "$1" } },
        },
      },
    ]);
  });

  test("ignores an unaddressed group message", async () => {
    const { api, deps } = await runChannel([
      syncWithRoomMessages("!room:example.org", [
        roomEvent({ content: { msgtype: "m.text", body: "lunch?" } }),
      ]),
    ]);

    expect(deps.answered).toEqual([]);
    expect(api.sent).toEqual([]);
  });

  test("answers a direct message without needing a mention", async () => {
    const { api } = await runChannel([
      syncWithRoomMessages(
        "!dm:example.org",
        [roomEvent({ content: { msgtype: "m.text", body: "hi" } })],
        {
          account_data: {
            events: [{ type: "m.direct", content: { "@alice:example.org": ["!dm:example.org"] } }],
          },
        },
      ),
    ]);

    expect(api.sent).toHaveLength(1);
    expect(api.sent[0]?.roomId).toBe("!dm:example.org");
  });

  test("never answers its own message (loop guard)", async () => {
    const { api } = await runChannel([
      syncWithRoomMessages("!room:example.org", [roomEvent({ sender: ME })]),
    ]);

    expect(api.sent).toEqual([]);
  });

  test("auto-joins an invited room", async () => {
    const { api } = await runChannel([
      { next_batch: "s1", rooms: { invite: { "!invited:example.org": invitedRoom() } } },
    ]);

    expect(api.joins).toEqual(["!invited:example.org"]);
  });

  test("autoJoin: false leaves invites alone", async () => {
    const { api } = await runChannel(
      [{ next_batch: "s1", rooms: { invite: { "!invited:example.org": invitedRoom() } } }],
      { autoJoin: false },
    );

    expect(api.joins).toEqual([]);
  });

  test("an is_direct invite makes the room a DM, answered without a mention", async () => {
    const { api } = await runChannel([
      {
        next_batch: "s1",
        rooms: { invite: { "!dm:example.org": invitedRoom({ isDirect: true }) } },
      },
      syncWithRoomMessages("!dm:example.org", [
        roomEvent({ content: { msgtype: "m.text", body: "hi" } }),
      ]),
    ]);

    expect(api.joins).toEqual(["!dm:example.org"]);
    expect(api.sent).toHaveLength(1);
    expect(api.sent[0]?.roomId).toBe("!dm:example.org");
  });

  test("an accepted DM invite is written to the bot's own m.direct, so a restart still knows", async () => {
    const { api } = await runChannel([
      {
        next_batch: "s1",
        rooms: { invite: { "!dm:example.org": invitedRoom({ isDirect: true }) } },
      },
    ]);

    expect(api.accountDataWrites).toEqual([
      {
        userId: ME,
        type: "m.direct",
        content: { "@alice:example.org": ["!dm:example.org"] },
      },
    ]);
  });

  test("a DM room already in the bot's m.direct is not written again", async () => {
    const api = fakeApi(
      [
        {
          next_batch: "s1",
          rooms: { invite: { "!dm:example.org": invitedRoom({ isDirect: true }) } },
        },
      ],
      { accountData: { "@alice:example.org": ["!dm:example.org"] } },
    );
    const logger = silentLogger();
    const channel = createMatrixChannel({
      homeserverUrl: "https://example.org",
      accessToken: "t",
      api,
      sleep: async () => undefined,
      logger,
    });

    await channel.start(fakeDeps(logger));
    await settle();
    await channel.stop?.();

    expect(api.accountDataWrites).toEqual([]);
  });

  test("a failed m.direct write is logged but the room is still a DM this session", async () => {
    const api = fakeApi(
      [
        {
          next_batch: "s1",
          rooms: { invite: { "!dm:example.org": invitedRoom({ isDirect: true }) } },
        },
        syncWithRoomMessages("!dm:example.org", [
          roomEvent({ content: { msgtype: "m.text", body: "hi" } }),
        ]),
      ],
      { accountDataWriteFails: true },
    );
    const logger = silentLogger();
    const channel = createMatrixChannel({
      homeserverUrl: "https://example.org",
      accessToken: "t",
      api,
      sleep: async () => undefined,
      logger,
    });

    await channel.start(fakeDeps(logger));
    await settle();
    await channel.stop?.();

    expect(api.sent).toHaveLength(1);
    expect(logger.lines.some((line) => line.includes("could not record"))).toBe(true);
  });

  test("a plain (non-direct) invite stays a group, so an unaddressed message is ignored", async () => {
    const { api } = await runChannel([
      {
        next_batch: "s1",
        rooms: { invite: { "!room:example.org": invitedRoom() } },
      },
      syncWithRoomMessages("!room:example.org", [
        roomEvent({ content: { msgtype: "m.text", body: "lunch?" } }),
      ]),
    ]);

    expect(api.accountDataWrites).toEqual([]);
    expect(api.sent).toEqual([]);
  });

  test("an invite outside allowedChats is left pending and logged once", async () => {
    const { api, logger } = await runChannel(
      [
        { next_batch: "s1", rooms: { invite: { "!stranger:example.org": invitedRoom() } } },
        { next_batch: "s2", rooms: { invite: { "!stranger:example.org": invitedRoom() } } },
      ],
      { allowedChats: ["!allowed:example.org"] },
    );

    expect(api.joins).toEqual([]);
    expect(logger.lines.filter((line) => line.includes("left invite"))).toHaveLength(1);
  });

  test("an invite to an allowlisted room is still accepted", async () => {
    const { api } = await runChannel(
      [{ next_batch: "s1", rooms: { invite: { "!allowed:example.org": invitedRoom() } } }],
      { allowedChats: ["!allowed:example.org"] },
    );

    expect(api.joins).toEqual(["!allowed:example.org"]);
  });

  test("an edit of an already-answered message is not answered again", async () => {
    const { api, deps } = await runChannel([
      syncWithRoomMessages("!room:example.org", [
        roomEvent({
          event_id: "$edit",
          content: {
            msgtype: "m.text",
            body: "* @Bot hello there",
            "m.mentions": { user_ids: [ME] },
            "m.new_content": { msgtype: "m.text", body: "@Bot hello there" },
            "m.relates_to": { rel_type: "m.replace", event_id: "$1" },
          },
        }),
      ]),
    ]);

    expect(deps.answered).toEqual([]);
    expect(api.sent).toEqual([]);
  });

  test("stop aborts the in-flight sync instead of waiting out its timeout", async () => {
    const { api } = await runChannel([{ next_batch: "s1" }]);

    expect(api.signals[0]).toBeDefined();
    expect(api.signals[0]?.aborted).toBe(true);
  });

  test("mute/unmute acknowledgements are sent unthreaded", async () => {
    const { api } = await runChannel(
      [
        syncWithRoomMessages("!room:example.org", [
          roomEvent({ event_id: "$mute", content: { msgtype: "m.text", body: "/mute" } }),
        ]),
      ],
      { muteRegex: /^\/mute$/i, unmuteRegex: /^\/unmute$/i, muteReply: "Muted." },
    );

    expect(api.sent).toEqual([
      { roomId: "!room:example.org", content: { msgtype: "m.text", body: "Muted." } },
    ]);
  });

  test("a non-allowlisted room is skipped and logged once", async () => {
    const { api, logger } = await runChannel(
      [
        syncWithRoomMessages("!room:example.org", [
          roomEvent({ event_id: "$1" }),
          roomEvent({ event_id: "$2" }),
        ]),
      ],
      { allowedChats: ["!other:example.org"] },
    );

    expect(api.sent).toEqual([]);
    expect(logger.lines.filter((line) => line.includes("not in allowedChats"))).toHaveLength(1);
  });

  test("the persona resolver receives the namespaced sender key", async () => {
    const seen: string[] = [];
    await runChannel([syncWithRoomMessages("!room:example.org", [roomEvent()])], {
      personaResolver: ({ sender }) => {
        seen.push(sender);
        return undefined;
      },
    });

    expect(seen).toEqual(["mx:@alice:example.org"]);
  });

  test("registers its own identity in the process registry, so a sibling channel sees it", async () => {
    const { deps } = await runChannel([]);
    expect(deps.identities.get("matrix")).toEqual([ME]);
  });

  test("a channel-supplied identity registry is used instead of the server's", async () => {
    const own = new Map<string, string[]>();
    const { deps } = await runChannel([], { identities: own, name: "matrix:support" });

    expect(own.get("matrix:support")).toEqual([ME]);
    expect(deps.identities.size).toBe(0);
  });

  test("a message from another endpoint of this process is ignored, not answered", async () => {
    const api = fakeApi([
      syncWithRoomMessages("!room:example.org", [roomEvent({ sender: "@support:example.org" })]),
    ]);
    const logger = silentLogger();
    const deps = fakeDeps(logger);
    // The sibling registered first, exactly as a channel started earlier in
    // the same createServer call would have.
    deps.identities.set("matrix:support", ["@support:example.org"]);

    const channel = createMatrixChannel({
      homeserverUrl: "https://example.org",
      accessToken: "test-token",
      api,
      sleep: async () => undefined,
      logger,
    });

    await channel.start(deps);
    await settle();
    await channel.stop?.();

    expect(deps.answered).toEqual([]);
    expect(api.sent).toEqual([]);
  });

  test("registers a sender supporting text, media and reactions", async () => {
    const api = fakeApi([{ next_batch: "s1" }]);
    const logger = silentLogger();
    const deps = fakeDeps(logger);
    const channel = createMatrixChannel({
      homeserverUrl: "https://example.org",
      accessToken: "t",
      api,
      sleep: async () => undefined,
      logger,
    });

    await channel.start(deps);
    expect(deps.senders.available("matrix")).toBe(true);
    expect(await deps.senders.sendText("matrix", "!room:example.org", "ping")).toBe(true);
    expect(await deps.senders.sendMedia("matrix", "!room:example.org", "mxc://example.org/x")).toBe(
      true,
    );
    expect(await deps.senders.sendReaction("matrix", "!room:example.org", "$1", "👍")).toBe(true);
    await channel.stop?.();

    expect(api.sent[0]).toEqual({
      roomId: "!room:example.org",
      content: { msgtype: "m.text", body: "ping" },
    });
    expect(api.media[0]).toEqual({ roomId: "!room:example.org", payload: "mxc://example.org/x" });
    expect(api.sent[1]?.content).toEqual({
      "m.relates_to": { rel_type: "m.annotation", event_id: "$1", key: "👍" },
    });
  });

  test("stop unregisters the sender so later sends degrade to false", async () => {
    const { deps } = await runChannel([{ next_batch: "s1" }]);
    expect(deps.senders.available("matrix")).toBe(false);
    expect(await deps.senders.sendText("matrix", "!room:example.org", "ping")).toBe(false);
  });

  test("a custom name lets two bots share one process and one registry", async () => {
    const logger = silentLogger();
    const deps = fakeDeps(logger);
    const channel = createMatrixChannel({
      homeserverUrl: "https://example.org",
      accessToken: "t",
      name: "matrix:support",
      api: fakeApi([{ next_batch: "s1" }]),
      sleep: async () => undefined,
      logger,
    });

    await channel.start(deps);
    expect(deps.senders.available("matrix:support")).toBe(true);
    await channel.stop?.();
  });

  test("a bad token fails start() rather than syncing forever", async () => {
    const api = fakeApi([], { whoamiFails: true });
    const logger = silentLogger();
    const deps = fakeDeps(logger);
    const channel = createMatrixChannel({
      homeserverUrl: "https://example.org",
      accessToken: "t",
      api,
      sleep: async () => undefined,
      logger,
    });

    await expect(channel.start(deps)).rejects.toThrow(/M_UNKNOWN_TOKEN/);
  });

  test("a throwing answerFn for one message doesn't cost the rest of the batch", async () => {
    const { api, logger } = await runChannel(
      [
        syncWithRoomMessages("!room:example.org", [
          roomEvent({ event_id: "$1", sender: "@alice:example.org" }),
          roomEvent({ event_id: "$2", sender: "@carol:example.org" }),
        ]),
      ],
      {
        answerFn: async ({ sender }) => {
          if (sender === "mx:@alice:example.org") throw new Error("brain unavailable");
          return "still here";
        },
      },
    );

    expect(api.sent).toEqual([
      {
        roomId: "!room:example.org",
        content: {
          msgtype: "m.text",
          body: "still here",
          "m.relates_to": { "m.in_reply_to": { event_id: "$2" } },
        },
      },
    ]);
    expect(
      logger.lines.some((line) => line.includes("$1 in !room:example.org handling failed")),
    ).toBe(true);
  });

  test("loads m.direct at start so a resumed session recognises an already-known DM immediately", async () => {
    const api = fakeApi(
      [
        syncWithRoomMessages("!dm:example.org", [
          roomEvent({ content: { msgtype: "m.text", body: "hi" } }),
        ]),
      ],
      { accountData: { "@alice:example.org": ["!dm:example.org"] } },
    );
    const logger = silentLogger();
    const deps = fakeDeps(logger);
    const channel = createMatrixChannel({
      homeserverUrl: "https://example.org",
      accessToken: "t",
      api,
      sleep: async () => undefined,
      logger,
      initialSince: "resume-token",
    });

    await channel.start(deps);
    await settle();
    await channel.stop?.();

    // The whole point of the fixture: `initialSince` must actually reach
    // the first `/sync` call, or this test would pass the same way with the
    // resume token silently dropped and every restart re-syncing from
    // scratch.
    expect(api.syncs[0]).toBe("resume-token");
    expect(api.sent).toHaveLength(1);
    expect(api.sent[0]?.roomId).toBe("!dm:example.org");
  });

  test("an unrelated account-data batch does not erase an already-known DM room", async () => {
    const api = fakeApi(
      [
        { next_batch: "s1", account_data: { events: [{ type: "m.push_rules", content: {} }] } },
        syncWithRoomMessages("!dm:example.org", [
          roomEvent({ content: { msgtype: "m.text", body: "hi" } }),
        ]),
      ],
      { accountData: { "@alice:example.org": ["!dm:example.org"] } },
    );
    const logger = silentLogger();
    const deps = fakeDeps(logger);
    const channel = createMatrixChannel({
      homeserverUrl: "https://example.org",
      accessToken: "t",
      api,
      sleep: async () => undefined,
      logger,
      autoJoin: false,
    });

    await channel.start(deps);
    await settle();
    await channel.stop?.();

    expect(api.sent).toHaveLength(1);
    expect(api.sent[0]?.roomId).toBe("!dm:example.org");
  });
});
