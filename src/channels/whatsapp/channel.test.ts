import { describe, expect, mock, test } from "bun:test";
import { createClient } from "@libsql/client";
import { createSenderRegistry } from "../senders";
import { type AuthStateRuntime, useTursoAuthState } from "./authState";
import {
  acquireSessionLease,
  createWhatsAppChannel,
  reconnectDelayMs,
  senderNameFor,
  shutdownWaSessions,
  type WaSessionHandle,
} from "./channel";
import { createTursoWaLeaseStore } from "./lease";

describe("reconnectDelayMs", () => {
  test("doubles each attempt, starting at 5s", () => {
    expect(reconnectDelayMs(0)).toBe(5_000);
    expect(reconnectDelayMs(1)).toBe(10_000);
    expect(reconnectDelayMs(2)).toBe(20_000);
    expect(reconnectDelayMs(3)).toBe(40_000);
  });

  test("caps at 10 minutes even after many failures", () => {
    expect(reconnectDelayMs(20)).toBe(10 * 60 * 1000);
    expect(reconnectDelayMs(1000)).toBe(10 * 60 * 1000);
  });
});

describe("senderNameFor", () => {
  test("the default session is unprefixed", () => {
    expect(senderNameFor("whatsapp", "default")).toBe("whatsapp");
  });

  test("a named session is prefixed with the channel name", () => {
    expect(senderNameFor("whatsapp", "second-number")).toBe("whatsapp:second-number");
  });
});

function fakeHandle(overrides: Partial<WaSessionHandle> = {}): WaSessionHandle {
  return {
    sock: { end: mock(() => undefined) },
    stopHeartbeat: mock(() => undefined),
    release: mock(async () => undefined),
    ...overrides,
  };
}

describe("shutdownWaSessions", () => {
  test("stops the heartbeat, ends the socket, then releases every session", async () => {
    const order: string[] = [];
    const handle = fakeHandle({
      stopHeartbeat: () => order.push("stopHeartbeat"),
      sock: { end: () => order.push("end") },
      release: async () => {
        order.push("release");
      },
    });
    const sessions = new Map([["default", handle]]);

    await shutdownWaSessions(sessions);

    expect(order).toEqual(["stopHeartbeat", "end", "release"]);
  });

  test("one session's rejecting release does not block or skip the others", async () => {
    const releasedA = mock(async () => undefined);
    const a = fakeHandle({ release: async () => Promise.reject(new Error("boom")) });
    const b = fakeHandle({ release: releasedA });
    const sessions = new Map([
      ["a", a],
      ["b", b],
    ]);

    await shutdownWaSessions(sessions);

    expect(a.stopHeartbeat).toHaveBeenCalledTimes(1);
    expect(releasedA).toHaveBeenCalledTimes(1);
  });
});

describe("acquireSessionLease", () => {
  test("does nothing once stopped", async () => {
    const connect = mock(async () => undefined);
    await acquireSessionLease("default", {
      leaseStore: { tryAcquire: mock(async () => true), release: mock(async () => undefined) },
      instanceId: "i1",
      sessions: new Map(),
      isStopped: () => true,
      connect,
    });

    expect(connect).not.toHaveBeenCalled();
  });

  test("connects once the lease is acquired", async () => {
    const connect = mock(async () => undefined);
    const sessions = new Map<string, WaSessionHandle>();

    await acquireSessionLease("default", {
      leaseStore: { tryAcquire: mock(async () => true), release: mock(async () => undefined) },
      instanceId: "i1",
      sessions,
      isStopped: () => false,
      connect,
      schedule: () => undefined,
    });

    expect(connect).toHaveBeenCalledWith("default");
    expect(sessions.has("default")).toBe(true);
    sessions.get("default")?.stopHeartbeat();
  });

  test("a denied lease retries via schedule instead of connecting", async () => {
    const connect = mock(async () => undefined);
    const schedule = mock((fn: () => void) => void fn());
    let acquireCalls = 0;
    const leaseStore = {
      tryAcquire: mock(async () => {
        acquireCalls++;
        return acquireCalls > 1; // denied first, granted on retry
      }),
      release: mock(async () => undefined),
    };
    const sessions = new Map<string, WaSessionHandle>();

    await acquireSessionLease("default", {
      leaseStore,
      instanceId: "i1",
      sessions,
      isStopped: () => false,
      connect,
      schedule,
    });

    expect(schedule).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith("default");
    sessions.get("default")?.stopHeartbeat();
  });

  test("connect throwing right after acquiring releases the lease and retries", async () => {
    const connect = mock(async () => {
      throw new Error("socket failed");
    });
    const release = mock(async () => undefined);
    const schedule = mock(() => undefined);
    const sessions = new Map<string, WaSessionHandle>();

    await acquireSessionLease("default", {
      leaseStore: { tryAcquire: mock(async () => true), release },
      instanceId: "i1",
      sessions,
      isStopped: () => false,
      connect,
      schedule,
    });

    expect(release).toHaveBeenCalledWith("default", "i1");
    expect(sessions.has("default")).toBe(false);
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  // The module's core safety property: if another instance ever takes the
  // lease (this instance went stale, or was otherwise superseded), the
  // heartbeat must notice and tear the session down — never keep running
  // connected alongside the new holder. Uses the real Turso-backed store
  // (an in-memory libsql client) rather than a fake, so the takeover is
  // driven through the same atomic upsert production traffic would hit.
  test("a heartbeat that finds the lease taken over ends the socket and re-enters the wait loop", async () => {
    const leaseStore = createTursoWaLeaseStore(createClient({ url: ":memory:" }));
    const sessions = new Map<string, WaSessionHandle>();
    const connect = mock(async () => undefined);
    const schedule = mock(() => undefined);

    await acquireSessionLease("default", {
      leaseStore,
      instanceId: "i1",
      sessions,
      isStopped: () => false,
      connect,
      schedule,
      heartbeatMs: 5,
      staleMs: 100_000,
    });

    const handle = sessions.get("default");
    expect(handle).toBeDefined();
    const end = mock(() => undefined);
    if (handle) handle.sock = { end };

    // Another instance takes over — a heartbeat_at far enough in the future
    // that it reads as fresher than "i1"'s real one, regardless of how much
    // wall-clock time this test actually takes.
    const stole = await leaseStore.tryAcquire("default", "i2", Date.now() + 1_000_000, 100_000);
    expect(stole).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(sessions.has("default")).toBe(false);
    expect(end).toHaveBeenCalledTimes(1);
    // The heartbeat's own retry() re-enters acquireSessionLease — with i2
    // now holding a lease that's fresh by construction, "i1" is denied and
    // falls into schedule() rather than reconnecting.
    expect(schedule).toHaveBeenCalled();
  });
});

// --- createWhatsAppChannel: end-to-end against a fake Baileys module ---

interface FakeSocket {
  user: { id: string };
  ev: {
    on: (event: string, handler: (payload: unknown) => void) => void;
    emit: (event: string, payload: unknown) => void;
  };
  sendMessage: ReturnType<typeof mock>;
  end: ReturnType<typeof mock>;
}

function createFakeSocket(): FakeSocket {
  const handlers = new Map<string, ((payload: unknown) => void)[]>();
  return {
    user: { id: "15550001234@s.whatsapp.net" },
    ev: {
      on: (event, handler) => {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      },
      emit: (event, payload) => {
        for (const handler of handlers.get(event) ?? []) handler(payload);
      },
    },
    sendMessage: mock(async () => undefined),
    end: mock(() => undefined),
  };
}

function fakeBaileysModule(opts: {
  registered: boolean;
  sockets: FakeSocket[];
  socketOptions?: { auth: { creds: unknown }; version: unknown }[];
}) {
  return {
    BufferJSON: { replacer: (_k: string, v: unknown) => v, reviver: (_k: string, v: unknown) => v },
    initAuthCreds: () => ({ registered: opts.registered, noiseKey: {} }),
    proto: { Message: { AppStateSyncKeyData: { fromObject: (v: unknown) => v } } },
    fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 0] as [number, number, number] }),
    makeCacheableSignalKeyStore: (keys: unknown) => keys,
    DisconnectReason: { loggedOut: 401 },
    makeWASocket: (options: { auth: { creds: unknown }; version: unknown }) => {
      const sock = createFakeSocket();
      opts.sockets.push(sock);
      opts.socketOptions?.push(options);
      return sock;
    },
    // biome-ignore lint/suspicious/noExplicitAny: minimal structural fake of the Baileys module for tests
  } as any;
}

function flush(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function testDeps(db = createClient({ url: ":memory:" })) {
  const senders = createSenderRegistry();
  return {
    deps: {
      client: {} as never,
      store: {} as never,
      db,
      config: {} as never,
      prompts: {} as never,
      senders,
    },
    senders,
    db,
  };
}

describe("createWhatsAppChannel", () => {
  test("an unpaired session never connects and schedules a re-check instead", async () => {
    const sockets: FakeSocket[] = [];
    const schedule = mock(() => undefined);
    const channel = createWhatsAppChannel({
      sessionSecret: "secret",
      loadBaileys: async () => fakeBaileysModule({ registered: false, sockets }),
      schedule,
    });
    const { deps, senders } = testDeps();

    await channel.start(deps);
    await flush();

    expect(sockets).toHaveLength(0);
    expect(schedule).toHaveBeenCalledWith(expect.any(Function), 60_000);
    expect(senders.available("whatsapp")).toBe(false);
  });

  test("a paired default session connects and registers its sender unprefixed", async () => {
    const sockets: FakeSocket[] = [];
    const channel = createWhatsAppChannel({
      sessionSecret: "secret",
      loadBaileys: async () => fakeBaileysModule({ registered: true, sockets }),
      schedule: () => undefined,
    });
    const { deps, senders } = testDeps();

    await channel.start(deps);
    await flush();
    sockets[0]?.ev.emit("connection.update", { connection: "open" });

    expect(sockets).toHaveLength(1);
    expect(senders.available("whatsapp")).toBe(true);

    await senders.sendText("whatsapp", "12345@s.whatsapp.net", "hi");
    expect(sockets[0]?.sendMessage).toHaveBeenCalledWith("12345@s.whatsapp.net", { text: "hi" });
  });

  test("creds passed to makeWASocket are the ones actually stored in deps.db", async () => {
    const sockets: FakeSocket[] = [];
    const socketOptions: { auth: { creds: unknown }; version: unknown }[] = [];
    const db = createClient({ url: ":memory:" });
    const runtime: AuthStateRuntime = {
      bufferJSON: { replacer: (_k, v) => v, reviver: (_k, v) => v },
      initAuthCreds: () => ({ registered: false }) as never,
      appStateSyncKeyFromObject: (v) => v as never,
    };
    // Seed the DB exactly the way a completed `wa-pair` run would — through
    // the real useTursoAuthState, not a shortcut — with a marker only a
    // stored-and-reloaded row would carry.
    const seeded = await useTursoAuthState(db, "secret", "default", runtime);
    // Mutate the existing creds object in place, not `seeded.state.creds =`
    // — saveCreds() closes over the original object identity, so replacing
    // the reference would silently persist the wrong (unregistered) creds.
    Object.assign(seeded.state.creds, { registered: true, me: { id: "seeded-marker-42" } });
    await seeded.saveCreds();

    const channel = createWhatsAppChannel({
      sessionSecret: "secret",
      loadBaileys: async () => fakeBaileysModule({ registered: false, sockets, socketOptions }),
      schedule: () => undefined,
    });
    const { deps } = testDeps(db);

    await channel.start(deps);
    await flush();

    expect(sockets).toHaveLength(1);
    expect(socketOptions[0]?.auth.creds).toEqual({
      registered: true,
      me: { id: "seeded-marker-42" },
    });
  });

  test("multiple sessions register under distinct, session-prefixed names", async () => {
    const sockets: FakeSocket[] = [];
    const channel = createWhatsAppChannel({
      sessionSecret: "secret",
      sessionIds: ["default", "second"],
      loadBaileys: async () => fakeBaileysModule({ registered: true, sockets }),
      schedule: () => undefined,
    });
    const { deps, senders } = testDeps();

    await channel.start(deps);
    await flush();
    for (const sock of sockets) sock.ev.emit("connection.update", { connection: "open" });

    expect(senders.available("whatsapp")).toBe(true);
    expect(senders.available("whatsapp:second")).toBe(true);
  });

  test("raw inbound messages are handed to onMessage, uninterpreted", async () => {
    const sockets: FakeSocket[] = [];
    const received: unknown[] = [];
    const channel = createWhatsAppChannel({
      sessionSecret: "secret",
      loadBaileys: async () => fakeBaileysModule({ registered: true, sockets }),
      schedule: () => undefined,
      onMessage: (event) => {
        received.push(event.message);
      },
    });
    const { deps } = testDeps();

    await channel.start(deps);
    await flush();
    sockets[0]?.ev.emit("messages.upsert", { type: "notify", messages: [{ key: {}, id: "m1" }] });
    await flush();

    expect(received).toEqual([{ key: {}, id: "m1" }]);
  });

  test("a throwing onMessage handler is caught and logged, not left to crash the socket", async () => {
    const sockets: FakeSocket[] = [];
    const channel = createWhatsAppChannel({
      sessionSecret: "secret",
      loadBaileys: async () => fakeBaileysModule({ registered: true, sockets }),
      schedule: () => undefined,
      onMessage: () => {
        throw new Error("handler exploded");
      },
    });
    const { deps } = testDeps();

    await channel.start(deps);
    await flush();

    expect(() =>
      sockets[0]?.ev.emit("messages.upsert", { type: "notify", messages: [{ key: {} }] }),
    ).not.toThrow();
  });

  test("a loggedOut close unregisters the sender and does not reconnect", async () => {
    const sockets: FakeSocket[] = [];
    const schedule = mock(() => undefined);
    const channel = createWhatsAppChannel({
      sessionSecret: "secret",
      loadBaileys: async () => fakeBaileysModule({ registered: true, sockets }),
      schedule,
    });
    const { deps, senders } = testDeps();

    await channel.start(deps);
    await flush();
    sockets[0]?.ev.emit("connection.update", { connection: "open" });
    expect(senders.available("whatsapp")).toBe(true);

    sockets[0]?.ev.emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 401 } } },
    });

    expect(senders.available("whatsapp")).toBe(false);
    // No reconnect scheduled — 60s pairing re-check and lease waitMs never
    // fire in this scenario, so schedule must stay untouched.
    expect(schedule).not.toHaveBeenCalled();
  });

  test("a non-loggedOut close unregisters the sender, reconnects, and escalates backoff on repeat failures", async () => {
    const sockets: FakeSocket[] = [];
    const scheduled: [() => void, number][] = [];
    const schedule = mock((fn: () => void, ms: number) => {
      scheduled.push([fn, ms]);
    });
    const channel = createWhatsAppChannel({
      sessionSecret: "secret",
      loadBaileys: async () => fakeBaileysModule({ registered: true, sockets }),
      schedule,
    });
    const { deps, senders } = testDeps();

    await channel.start(deps);
    await flush();
    sockets[0]?.ev.emit("connection.update", { connection: "open" });

    sockets[0]?.ev.emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 515 } } },
    });

    expect(senders.available("whatsapp")).toBe(false);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.[1]).toBe(5_000);

    // Actually run the scheduled reconnect — a stub that never connects
    // again would pass a test that only checks the schedule() call.
    scheduled[0]?.[0]();
    await flush();
    expect(sockets).toHaveLength(2);

    // A second consecutive failure (no "open" in between) must back off
    // further, not repeat the same 5s delay.
    sockets[1]?.ev.emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 515 } } },
    });
    expect(scheduled).toHaveLength(2);
    expect(scheduled[1]?.[1]).toBe(10_000);

    // A successful open resets the backoff back to the base delay.
    scheduled[1]?.[0]();
    await flush();
    sockets[2]?.ev.emit("connection.update", { connection: "open" });
    sockets[2]?.ev.emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 515 } } },
    });
    expect(scheduled).toHaveLength(3);
    expect(scheduled[2]?.[1]).toBe(5_000);
  });

  test("a pending reconnect timer that fires after this instance lost the session's lease does not open an orphan socket", async () => {
    const sockets: FakeSocket[] = [];
    let reconnect: (() => void) | undefined;
    const schedule = mock((fn: () => void, ms: number) => {
      if (ms === 5_000) reconnect = fn;
    });
    const channel = createWhatsAppChannel({
      sessionSecret: "secret",
      loadBaileys: async () => fakeBaileysModule({ registered: true, sockets }),
      schedule,
    });
    const { deps, senders } = testDeps();

    await channel.start(deps);
    await flush();
    sockets[0]?.ev.emit("connection.update", { connection: "open" });
    sockets[0]?.ev.emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 515 } } },
    });
    expect(reconnect).toBeDefined();

    // Simulate this instance losing the session entirely (heartbeat loss,
    // or stop()) between the close and the pending reconnect firing.
    await channel.stop?.();
    reconnect?.();
    await flush();

    expect(sockets).toHaveLength(1); // no second, untracked socket opened
    expect(senders.available("whatsapp")).toBe(false);
  });

  test("stop() unregisters every sender and ends every socket", async () => {
    const sockets: FakeSocket[] = [];
    const channel = createWhatsAppChannel({
      sessionSecret: "secret",
      sessionIds: ["default", "second"],
      loadBaileys: async () => fakeBaileysModule({ registered: true, sockets }),
      schedule: () => undefined,
    });
    const { deps, senders } = testDeps();

    await channel.start(deps);
    await flush();
    for (const sock of sockets) sock.ev.emit("connection.update", { connection: "open" });
    expect(senders.available("whatsapp")).toBe(true);
    expect(senders.available("whatsapp:second")).toBe(true);

    await channel.stop?.();

    expect(senders.available("whatsapp")).toBe(false);
    expect(senders.available("whatsapp:second")).toBe(false);
    for (const sock of sockets) expect(sock.end).toHaveBeenCalledTimes(1);
  });
});
