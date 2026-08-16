import { describe, expect, test } from "bun:test";
import type { Logger } from "../../core/logger";
import type { PromptLoader } from "../../core/prompts";
import type { VectorStore } from "../../core/retrieval";
import type { ChatterConfig, ServerDependencies } from "../../types";
import { createSenderRegistry } from "../senders";
import type { MatrixApi, MatrixEvent, MatrixSyncResponse } from "./api";
import { createMatrixChannel, type MatrixChannelConfig } from "./channel";

const ME = "@bot:example.org";

interface FakeApi extends MatrixApi {
  sent: Array<{ roomId: string; content: Record<string, unknown> }>;
  media: Array<{ roomId: string; payload: unknown }>;
  joins: string[];
  syncs: Array<string | undefined>;
}

/** A homeserver that serves one scripted batch of sync responses and then hangs — no network, no token. */
function fakeApi(
  batches: MatrixSyncResponse[],
  options: { whoamiFails?: boolean; accountData?: Record<string, unknown> } = {},
): FakeApi {
  const sent: FakeApi["sent"] = [];
  const media: FakeApi["media"] = [];
  const joins: FakeApi["joins"] = [];
  const syncs: FakeApi["syncs"] = [];
  let round = 0;
  let eventCounter = 0;

  return {
    sent,
    media,
    joins,
    syncs,
    call: async () => undefined as never,
    whoami: async () => {
      if (options.whoamiFails) throw new Error("M_UNKNOWN_TOKEN");
      return { userId: ME };
    },
    sync: ({ since }) => {
      syncs.push(since);
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
    store: { query: async () => ["context"] } as unknown as VectorStore,
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
      { next_batch: "s1", rooms: { invite: { "!invited:example.org": {} } } },
    ]);

    expect(api.joins).toEqual(["!invited:example.org"]);
  });

  test("autoJoin: false leaves invites alone", async () => {
    const { api } = await runChannel(
      [{ next_batch: "s1", rooms: { invite: { "!invited:example.org": {} } } }],
      { autoJoin: false },
    );

    expect(api.joins).toEqual([]);
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
