import { describe, expect, mock, test } from "bun:test";
import { createClient } from "@libsql/client";
import type { Logger } from "../../core/logger";
import { createSenderRegistry } from "../senders";
import {
  type AuthStateRuntime,
  isAuthRowForSession,
  useTursoAuthState,
  type WaAuthKV,
} from "./authState";
import {
  acquireSessionLease,
  createWhatsAppChannel,
  normalizeWaMediaPayload,
  reconnectDelayMs,
  senderNameFor,
  shutdownWaSessions,
  type WaSessionHandle,
} from "./channel";
import { createTursoWaLeaseStore, type WaLeaseStore } from "./lease";

/** An in-memory `WaAuthKV` for tests that inject `config.authStore`. */
function fakeAuthKV(): WaAuthKV {
  const rows = new Map<string, string>();
  return {
    async read(id) {
      return rows.has(id) ? (rows.get(id) as string) : null;
    },
    async write(id, value) {
      rows.set(id, value);
    },
    async remove(id) {
      rows.delete(id);
    },
    async clear(sessionId) {
      for (const id of [...rows.keys()]) {
        if (isAuthRowForSession(id, sessionId)) rows.delete(id);
      }
    },
  };
}

/** An in-memory `WaLeaseStore` for tests that inject `config.leaseStore`. */
function fakeLeaseStore(): WaLeaseStore & { isHeld: (sessionId: string) => boolean } {
  const held = new Map<string, string>();
  return {
    async tryAcquire(sessionId, instanceId) {
      const current = held.get(sessionId);
      if (current && current !== instanceId) return false;
      held.set(sessionId, instanceId);
      return true;
    },
    async release(sessionId, instanceId) {
      if (held.get(sessionId) === instanceId) held.delete(sessionId);
    },
    isHeld: (sessionId) => held.has(sessionId),
  };
}

/**
 * A `WaLeaseStore` whose acquires can be left in flight, for driving the
 * ordering where a heartbeat's renewal is still pending when a connect
 * attempt fails.
 */
function parkableLeaseStore(): WaLeaseStore & {
  parkAcquires: () => void;
  resolveParkedAcquires: (stillHeld: boolean) => void;
} {
  let parking = false;
  let parked: ((stillHeld: boolean) => void)[] = [];
  return {
    tryAcquire() {
      if (parking) return new Promise<boolean>((resolve) => parked.push(resolve));
      return Promise.resolve(true);
    },
    async release() {},
    parkAcquires: () => {
      parking = true;
    },
    resolveParkedAcquires: (stillHeld) => {
      const waiting = parked;
      parked = [];
      parking = false;
      for (const resolve of waiting) resolve(stillHeld);
    },
  };
}

/**
 * A `WaAuthKV` whose reads can be switched to reject, standing in for the
 * database blip that makes a connect attempt throw while loading auth state.
 */
function flakyAuthKV(): WaAuthKV & {
  failReads: (failing: boolean) => void;
  parkReads: () => void;
  failParkedReads: () => void;
} {
  const inner = fakeAuthKV();
  let failing = false;
  let parking = false;
  let parked: ((error: Error) => void)[] = [];
  return {
    ...inner,
    read(id) {
      if (parking) return new Promise((_resolve, reject) => parked.push(reject));
      if (failing) return Promise.reject(new Error("ECONNRESET reading auth state"));
      return inner.read(id);
    },
    failReads: (value) => {
      failing = value;
    },
    /** Leave the next reads pending, so a connect attempt sits in flight. */
    parkReads: () => {
      parking = true;
    },
    failParkedReads: () => {
      const waiting = parked;
      parked = [];
      for (const reject of waiting) reject(new Error("ECONNRESET reading auth state"));
    },
  };
}

describe("createWhatsAppChannel", () => {
  test("throws immediately on a weak sessionSecret, before any connection attempt", () => {
    expect(() => createWhatsAppChannel({ sessionSecret: "too-short" })).toThrow("too weak");
  });

  test("throws immediately on an empty sessionSecret", () => {
    expect(() => createWhatsAppChannel({ sessionSecret: "" })).toThrow(
      "is required and cannot be empty",
    );
  });
});

describe("normalizeWaMediaPayload", () => {
  test("a bare string is shorthand for the URL", () => {
    expect(normalizeWaMediaPayload("https://example.org/pic.png")).toEqual({
      url: "https://example.org/pic.png",
    });
  });

  test("an object payload passes through", () => {
    const payload = { url: "https://example.org/pic.png", caption: "hi" };
    expect(normalizeWaMediaPayload(payload)).toEqual(payload);
  });

  test("throws on a payload with no usable url", () => {
    expect(() => normalizeWaMediaPayload({ caption: "hi" })).toThrow(/must be a URL string/);
    expect(() => normalizeWaMediaPayload(undefined)).toThrow(/must be a URL string/);
    expect(() => normalizeWaMediaPayload(42)).toThrow(/must be a URL string/);
  });
});

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

  test("an injected onConnectFailed owns the recovery for a thrown connect", async () => {
    const failure = new Error("auth state unavailable");
    const connect = mock(async () => {
      throw failure;
    });
    const release = mock(async () => undefined);
    const schedule = mock(() => undefined);
    const onConnectFailed = mock(() => undefined);
    const sessions = new Map<string, WaSessionHandle>();

    await acquireSessionLease("default", {
      leaseStore: { tryAcquire: mock(async () => true), release },
      instanceId: "i1",
      sessions,
      isStopped: () => false,
      connect,
      schedule,
      onConnectFailed,
    });

    expect(onConnectFailed).toHaveBeenCalledWith("default", failure);
    // The handler takes over the entire recovery - releasing the session and
    // scheduling the next attempt on its own backoff - so the default path
    // must not also fire and start a second, competing retry chain.
    expect(release).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
    sessions.get("default")?.stopHeartbeat();
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

  // The gap the takeover test above doesn't cover: tryAcquire can also
  // reject (a database blip), not just resolve false. Before this test
  // existed, a rejecting heartbeat was only ever warned and retried forever
  // - so if Turso stayed unreachable long enough for the lease row to go
  // stale, another instance could legitimately steal it while this one kept
  // believing it was still connected.
  test("heartbeats that keep rejecting for >= staleMs tear the session down and re-enter the wait loop", async () => {
    let acquireCount = 0;
    const leaseStore: WaLeaseStore = {
      tryAcquire: mock(async () => {
        acquireCount += 1;
        if (acquireCount === 1) return true; // the initial acquire before connecting
        throw new Error("turso unreachable");
      }),
      release: mock(async () => undefined),
    };
    const sessions = new Map<string, WaSessionHandle>();
    const connect = mock(async () => undefined);
    const schedule = mock(() => undefined);
    const errors: unknown[][] = [];
    const logger: Logger = {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: (...args) => errors.push(args),
    };

    await acquireSessionLease("default", {
      leaseStore,
      instanceId: "i1",
      sessions,
      isStopped: () => false,
      connect,
      schedule,
      logger,
      heartbeatMs: 10,
      staleMs: 50,
    });

    const handle = sessions.get("default");
    expect(handle).toBeDefined();
    const end = mock(() => undefined);
    if (handle) handle.sock = { end };

    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(sessions.has("default")).toBe(false);
    expect(end).toHaveBeenCalledTimes(1);
    expect(schedule).toHaveBeenCalled();
    const message = errors
      .map((args) => String(args[0]))
      .find((text) => text.includes("failing for"));
    expect(message).toBeDefined();
    expect(message).toContain("WhatsApp[default]");
  });

  test("a single transient heartbeat rejection followed by a success does not tear down the session", async () => {
    let acquireCount = 0;
    const leaseStore: WaLeaseStore = {
      tryAcquire: mock(async () => {
        acquireCount += 1;
        if (acquireCount === 2) throw new Error("turso blip"); // one heartbeat tick fails
        return true;
      }),
      release: mock(async () => undefined),
    };
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
      heartbeatMs: 10,
      staleMs: 200,
    });

    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(sessions.has("default")).toBe(true);
    expect(schedule).not.toHaveBeenCalled();
    sessions.get("default")?.stopHeartbeat();
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

/** Polls until `predicate` is true, or throws after `timeoutMs` - for asserting on real scrypt-backed async work without betting a fixed delay is long enough. */
async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await flush(10);
  }
  throw new Error("waitFor: timed out");
}

const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

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
      logger: silentLogger,
    },
    senders,
    db,
  };
}

describe("createWhatsAppChannel", () => {
  test("start() fails fast with an actionable message when deps.db is absent", async () => {
    const channel = createWhatsAppChannel({
      sessionSecret: "test-session-secret-value",
      loadBaileys: async () => fakeBaileysModule({ registered: true, sockets: [] }),
      schedule: () => undefined,
    });
    // A host running config.retriever with no config.database never opens
    // deps.db (see ServerDependencies.db's doc comment) - this channel needs
    // one for auth state and the session lease regardless of retriever.
    const { deps } = testDeps();
    (deps as { db: unknown }).db = undefined;

    await expect(channel.start(deps)).rejects.toThrow(/needs a libsql client/);
  });

  test("start() fails fast when only one of leaseStore/authStore is injected and deps.db is absent", async () => {
    const channel = createWhatsAppChannel({
      sessionSecret: "test-session-secret-value",
      loadBaileys: async () => fakeBaileysModule({ registered: true, sockets: [] }),
      schedule: () => undefined,
      leaseStore: fakeLeaseStore(),
    });
    const { deps } = testDeps();
    (deps as { db: unknown }).db = undefined;

    await expect(channel.start(deps)).rejects.toThrow(/needs a libsql client/);
  });

  test("start() succeeds without deps.db when both leaseStore and authStore are injected", async () => {
    const sockets: FakeSocket[] = [];
    const channel = createWhatsAppChannel({
      sessionSecret: "test-session-secret-value",
      loadBaileys: async () => fakeBaileysModule({ registered: true, sockets }),
      schedule: () => undefined,
      leaseStore: fakeLeaseStore(),
      authStore: fakeAuthKV(),
    });
    const { deps, senders } = testDeps();
    (deps as { db: unknown }).db = undefined;

    await channel.start(deps);
    await flush();
    sockets[0]?.ev.emit("connection.update", { connection: "open" });

    expect(sockets).toHaveLength(1);
    expect(senders.available("whatsapp")).toBe(true);
  });

  test("an injected authStore is written to on creds.update, independent of deps.db", async () => {
    const authStore = fakeAuthKV();
    const sockets: FakeSocket[] = [];
    const channel = createWhatsAppChannel({
      sessionSecret: "test-session-secret-value",
      loadBaileys: async () => fakeBaileysModule({ registered: true, sockets }),
      schedule: () => undefined,
      leaseStore: fakeLeaseStore(),
      authStore,
    });
    const { deps } = testDeps();
    (deps as { db: unknown }).db = undefined;

    await channel.start(deps);
    await flush();
    sockets[0]?.ev.emit("creds.update", undefined);
    // saveCreds() is fire-and-forget from the "creds.update" handler and runs
    // real scrypt-backed encrypt(); poll instead of betting on a fixed delay.
    await waitFor(async () => (await authStore.read("creds")) !== null);

    expect(await authStore.read("creds")).not.toBeNull();
  });

  test("an unpaired session never connects and schedules a re-check instead", async () => {
    const sockets: FakeSocket[] = [];
    const schedule = mock(() => undefined);
    const channel = createWhatsAppChannel({
      sessionSecret: "test-session-secret-value",
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
      sessionSecret: "test-session-secret-value",
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

  test("a paired session's sender supports sendReaction via a Baileys reaction message", async () => {
    const sockets: FakeSocket[] = [];
    const channel = createWhatsAppChannel({
      sessionSecret: "test-session-secret-value",
      loadBaileys: async () => fakeBaileysModule({ registered: true, sockets }),
      schedule: () => undefined,
    });
    const { deps, senders } = testDeps();

    await channel.start(deps);
    await flush();
    sockets[0]?.ev.emit("connection.update", { connection: "open" });

    const messageRef = { remoteJid: "12345@s.whatsapp.net", id: "ABC123", fromMe: false };
    const ok = await senders.sendReaction("whatsapp", "12345@s.whatsapp.net", messageRef, "👍");

    expect(ok).toBe(true);
    expect(sockets[0]?.sendMessage).toHaveBeenCalledWith("12345@s.whatsapp.net", {
      react: { text: "👍", key: messageRef },
    });
  });

  test("a paired session's sender supports sendMedia via a Baileys image message", async () => {
    const sockets: FakeSocket[] = [];
    const channel = createWhatsAppChannel({
      sessionSecret: "test-session-secret-value",
      loadBaileys: async () => fakeBaileysModule({ registered: true, sockets }),
      schedule: () => undefined,
    });
    const { deps, senders } = testDeps();

    await channel.start(deps);
    await flush();
    sockets[0]?.ev.emit("connection.update", { connection: "open" });

    const ok = await senders.sendMedia("whatsapp", "12345@s.whatsapp.net", {
      url: "https://example.org/pic.png",
      caption: "here you go",
    });

    expect(ok).toBe(true);
    expect(sockets[0]?.sendMessage).toHaveBeenCalledWith("12345@s.whatsapp.net", {
      image: { url: "https://example.org/pic.png" },
      caption: "here you go",
    });
  });

  test("sendMedia accepts a bare URL string, matching Telegram/Matrix's shorthand", async () => {
    const sockets: FakeSocket[] = [];
    const channel = createWhatsAppChannel({
      sessionSecret: "test-session-secret-value",
      loadBaileys: async () => fakeBaileysModule({ registered: true, sockets }),
      schedule: () => undefined,
    });
    const { deps, senders } = testDeps();

    await channel.start(deps);
    await flush();
    sockets[0]?.ev.emit("connection.update", { connection: "open" });

    const ok = await senders.sendMedia(
      "whatsapp",
      "12345@s.whatsapp.net",
      "https://example.org/pic.png",
    );

    expect(ok).toBe(true);
    expect(sockets[0]?.sendMessage).toHaveBeenCalledWith("12345@s.whatsapp.net", {
      image: { url: "https://example.org/pic.png" },
    });
  });

  test("sendMedia without a caption omits the caption field", async () => {
    const sockets: FakeSocket[] = [];
    const channel = createWhatsAppChannel({
      sessionSecret: "test-session-secret-value",
      loadBaileys: async () => fakeBaileysModule({ registered: true, sockets }),
      schedule: () => undefined,
    });
    const { deps, senders } = testDeps();

    await channel.start(deps);
    await flush();
    sockets[0]?.ev.emit("connection.update", { connection: "open" });

    await senders.sendMedia("whatsapp", "12345@s.whatsapp.net", {
      url: "https://example.org/pic.png",
    });

    expect(sockets[0]?.sendMessage).toHaveBeenCalledWith("12345@s.whatsapp.net", {
      image: { url: "https://example.org/pic.png" },
    });
  });

  test("a custom name lets two WhatsApp channels share one process and one registry", async () => {
    const sockets: FakeSocket[] = [];
    const channel = createWhatsAppChannel({
      name: "whatsapp:support",
      sessionSecret: "test-session-secret-value",
      loadBaileys: async () => fakeBaileysModule({ registered: true, sockets }),
      schedule: () => undefined,
    });
    const { deps, senders } = testDeps();

    await channel.start(deps);
    await flush();
    sockets[0]?.ev.emit("connection.update", { connection: "open" });

    expect(senders.available("whatsapp:support")).toBe(true);
    expect(senders.available("whatsapp")).toBe(false);
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
    const seeded = await useTursoAuthState(db, "test-session-secret-value", "default", runtime);
    // Mutate the existing creds object in place, not `seeded.state.creds =`
    // — saveCreds() closes over the original object identity, so replacing
    // the reference would silently persist the wrong (unregistered) creds.
    Object.assign(seeded.state.creds, { registered: true, me: { id: "seeded-marker-42" } });
    await seeded.saveCreds();

    const channel = createWhatsAppChannel({
      sessionSecret: "test-session-secret-value",
      loadBaileys: async () => fakeBaileysModule({ registered: false, sockets, socketOptions }),
      schedule: () => undefined,
    });
    const { deps } = testDeps(db);

    await channel.start(deps);
    // Real scrypt-backed decrypt() runs inside connect(), not just the sha256
    // it replaced — give it real time to finish before asserting.
    await flush(300);

    expect(sockets).toHaveLength(1);
    expect(socketOptions[0]?.auth.creds).toEqual({
      registered: true,
      me: { id: "seeded-marker-42" },
    });
  });

  test("multiple sessions register under distinct, session-prefixed names", async () => {
    const sockets: FakeSocket[] = [];
    const channel = createWhatsAppChannel({
      sessionSecret: "test-session-secret-value",
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
      sessionSecret: "test-session-secret-value",
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
      sessionSecret: "test-session-secret-value",
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
      sessionSecret: "test-session-secret-value",
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
      sessionSecret: "test-session-secret-value",
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

  // The failure mode this guards against in production: a routine close
  // scheduled a reconnect, the reconnect threw while loading auth state
  // (transient database error), and the retry chain ended there - lease
  // still held, no socket, nothing scheduled, and no future "close" event to
  // wake it. The instance kept answering health checks and renewing its
  // lease while serving nothing, until a human restarted it.
  test("a reconnect whose connect() throws re-enters the retry loop instead of dead-ending", async () => {
    const sockets: FakeSocket[] = [];
    const scheduled: [() => void, number][] = [];
    const schedule = mock((fn: () => void, ms: number) => {
      scheduled.push([fn, ms]);
    });
    const leaseStore = fakeLeaseStore();
    const authStore = flakyAuthKV();
    const channel = createWhatsAppChannel({
      sessionSecret: "test-session-secret-value",
      loadBaileys: async () => fakeBaileysModule({ registered: true, sockets }),
      schedule,
      leaseStore,
      authStore,
    });
    const { deps } = testDeps();

    await channel.start(deps);
    await waitFor(async () => sockets.length === 1);
    sockets[0]?.ev.emit("connection.update", { connection: "open" });
    expect(leaseStore.isHeld("default")).toBe(true);

    // The database goes away, then the connection drops: the scheduled
    // reconnect rejects while loading auth state, leaving no socket behind
    // and so no "close" event that could drive a further attempt.
    authStore.failReads(true);
    sockets[0]?.ev.emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 428 } } },
    });
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.[1]).toBe(5_000);
    scheduled[0]?.[0]();

    // Recovery, not a dead end - and none of the three zombie conditions
    // holds: the lease is released, and another attempt is pending, with the
    // thrown attempt counted on the same backoff as a closed connection.
    await waitFor(async () => scheduled.length === 2);
    expect(sockets).toHaveLength(1);
    expect(leaseStore.isHeld("default")).toBe(false);
    expect(scheduled[1]?.[1]).toBe(10_000);

    // Still down: the next attempt re-acquires the lease, throws again, and
    // keeps backing off rather than hot-looping at the base delay or
    // stopping altogether.
    scheduled[1]?.[0]();
    await waitFor(async () => scheduled.length === 3);
    expect(sockets).toHaveLength(1);
    expect(leaseStore.isHeld("default")).toBe(false);
    expect(scheduled[2]?.[1]).toBe(20_000);

    // Database back: the same retry chain reconnects unaided.
    authStore.failReads(false);
    scheduled[2]?.[0]();
    await waitFor(async () => sockets.length === 2);
    expect(leaseStore.isHeld("default")).toBe(true);

    await channel.stop?.();
  });

  test("a lease release that never settles still leaves the next attempt scheduled", async () => {
    const sockets: FakeSocket[] = [];
    const scheduled: [() => void, number][] = [];
    const schedule = mock((fn: () => void, ms: number) => {
      scheduled.push([fn, ms]);
    });
    const authStore = flakyAuthKV();
    // The database is not rejecting, it is hanging - so the teardown after a
    // failed connect never completes. Waiting on it before scheduling the
    // next attempt would reproduce the zombie this whole path exists to
    // prevent, from the same failure it is recovering from.
    const leaseStore: WaLeaseStore = {
      async tryAcquire() {
        return true;
      },
      release: () => new Promise<void>(() => {}),
    };
    const channel = createWhatsAppChannel({
      sessionSecret: "test-session-secret-value",
      loadBaileys: async () => fakeBaileysModule({ registered: true, sockets }),
      schedule,
      leaseStore,
      authStore,
    });
    const { deps } = testDeps();

    await channel.start(deps);
    await waitFor(async () => sockets.length === 1);
    sockets[0]?.ev.emit("connection.update", { connection: "open" });

    authStore.failReads(true);
    sockets[0]?.ev.emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 428 } } },
    });
    scheduled[0]?.[0]();

    await waitFor(async () => scheduled.length === 2);
    expect(scheduled[1]?.[1]).toBe(10_000);
  });

  test("a failed connect and a heartbeat that lost the lease start one retry chain, not two", async () => {
    const sockets: FakeSocket[] = [];
    const scheduled: [() => void, number][] = [];
    const schedule = mock((fn: () => void, ms: number) => {
      scheduled.push([fn, ms]);
    });
    const leaseStore = parkableLeaseStore();
    const authStore = flakyAuthKV();
    const channel = createWhatsAppChannel({
      sessionSecret: "test-session-secret-value",
      loadBaileys: async () => fakeBaileysModule({ registered: true, sockets }),
      schedule,
      leaseStore,
      authStore,
      heartbeatMs: 5,
      waitMs: 30_000,
    });
    const { deps } = testDeps();

    await channel.start(deps);
    await waitFor(async () => sockets.length === 1);
    sockets[0]?.ev.emit("connection.update", { connection: "open" });

    // A heartbeat renewal is left in flight (a slow database is what makes
    // this window more than theoretical) while the connection drops and the
    // reconnect fails.
    authStore.failReads(true);
    leaseStore.parkAcquires();
    await flush();
    sockets[0]?.ev.emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 428 } } },
    });
    scheduled[0]?.[0]();
    await waitFor(async () => scheduled.length === 2);
    expect(scheduled[1]?.[1]).toBe(10_000); // the failed connect's own recovery

    // The parked renewal now comes back saying another instance holds the
    // lease. The failed connect already gave the session up and owns the
    // recovery, so this must not add a second chain: two chains re-acquire
    // under one instance id (which the lease store grants, same holder) and
    // end up running two sockets for one WhatsApp number.
    leaseStore.resolveParkedAcquires(false);
    await flush();

    expect(scheduled).toHaveLength(2);
    expect(sockets).toHaveLength(1);

    await channel.stop?.();
  });

  test("a connect already in flight when stop() lands does not resurrect the session", async () => {
    const sockets: FakeSocket[] = [];
    const scheduled: [() => void, number][] = [];
    const schedule = mock((fn: () => void, ms: number) => {
      scheduled.push([fn, ms]);
    });
    const leaseStore = fakeLeaseStore();
    const authStore = flakyAuthKV();
    const channel = createWhatsAppChannel({
      sessionSecret: "test-session-secret-value",
      loadBaileys: async () => fakeBaileysModule({ registered: true, sockets }),
      schedule,
      leaseStore,
      authStore,
    });
    const { deps } = testDeps();

    await channel.start(deps);
    await waitFor(async () => sockets.length === 1);
    sockets[0]?.ev.emit("connection.update", { connection: "open" });

    // Park the auth read so the reconnect is genuinely mid-flight - a
    // rejection arriving before stop() would be screened out by connect()'s
    // own entry guard and never reach the recovery path at all.
    authStore.parkReads();
    sockets[0]?.ev.emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 428 } } },
    });
    scheduled[0]?.[0]();
    await flush();

    await channel.stop?.();
    authStore.failParkedReads();
    await flush();

    // Recovery is for sessions this instance still wants: a deliberate
    // teardown must not be handed a fresh retry chain by a late rejection.
    expect(scheduled).toHaveLength(1);
    expect(sockets).toHaveLength(1);
  });

  test("a pending reconnect timer that fires after this instance lost the session's lease does not open an orphan socket", async () => {
    const sockets: FakeSocket[] = [];
    let reconnect: (() => void) | undefined;
    const schedule = mock((fn: () => void, ms: number) => {
      if (ms === 5_000) reconnect = fn;
    });
    const channel = createWhatsAppChannel({
      sessionSecret: "test-session-secret-value",
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
      sessionSecret: "test-session-secret-value",
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

describe("createWhatsAppChannel().getStatus", () => {
  test("reflects connect, open and close transitions", async () => {
    const sockets: FakeSocket[] = [];
    const channel = createWhatsAppChannel({
      sessionSecret: "test-session-secret-value",
      loadBaileys: async () => fakeBaileysModule({ registered: true, sockets }),
      schedule: () => undefined,
    });
    const { deps } = testDeps();

    await channel.start(deps);
    await flush();
    expect(channel.getStatus()).toEqual([
      { sessionId: "default", state: "connecting", since: expect.any(Number) },
    ]);

    sockets[0]?.ev.emit("connection.update", { connection: "open" });
    expect(channel.getStatus()).toEqual([
      { sessionId: "default", state: "connected", since: expect.any(Number) },
    ]);

    sockets[0]?.ev.emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 500 } } },
    });
    const [status] = channel.getStatus();
    expect(status?.state).toBe("disconnected");
    expect(status?.lastError).toMatch(/connection closed \(500\)/);
  });

  test("an unpaired session reports disconnected with a pairing hint", async () => {
    const sockets: FakeSocket[] = [];
    const channel = createWhatsAppChannel({
      sessionSecret: "test-session-secret-value",
      loadBaileys: async () => fakeBaileysModule({ registered: false, sockets }),
      schedule: () => undefined,
    });
    const { deps } = testDeps();

    await channel.start(deps);
    await flush();

    const [status] = channel.getStatus();
    expect(status?.state).toBe("disconnected");
    expect(status?.lastError).toMatch(/pair it first/);
  });

  test("a logged-out session reports disconnected with a re-pair hint and does not reconnect", async () => {
    const sockets: FakeSocket[] = [];
    const channel = createWhatsAppChannel({
      sessionSecret: "test-session-secret-value",
      loadBaileys: async () => fakeBaileysModule({ registered: true, sockets }),
      schedule: () => undefined,
    });
    const { deps } = testDeps();

    await channel.start(deps);
    await flush();
    sockets[0]?.ev.emit("connection.update", { connection: "open" });
    sockets[0]?.ev.emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 401 } } },
    });

    const [status] = channel.getStatus();
    expect(status?.state).toBe("disconnected");
    expect(status?.lastError).toMatch(/re-pair/);
  });

  test("multiple sessions report independent statuses in configured order", async () => {
    const sockets: FakeSocket[] = [];
    const channel = createWhatsAppChannel({
      sessionSecret: "test-session-secret-value",
      sessionIds: ["default", "second"],
      loadBaileys: async () => fakeBaileysModule({ registered: true, sockets }),
      schedule: () => undefined,
    });
    const { deps } = testDeps();

    await channel.start(deps);
    await flush();
    sockets[0]?.ev.emit("connection.update", { connection: "open" });

    const statuses = channel.getStatus();
    expect(statuses.map((s) => s.sessionId)).toEqual(["default", "second"]);
    expect(statuses[0]?.state).toBe("connected");
    expect(statuses[1]?.state).toBe("connecting");
  });
});

describe("createWhatsAppChannel watchdog", () => {
  test("onUnhealthy fires once past unhealthyAfterMs, not before, and rearms on reconnect", async () => {
    const sockets: FakeSocket[] = [];
    let currentTime = 0;
    const onUnhealthy = mock(() => undefined);
    const channel = createWhatsAppChannel({
      sessionSecret: "test-session-secret-value",
      loadBaileys: async () => fakeBaileysModule({ registered: true, sockets }),
      schedule: () => undefined,
      now: () => currentTime,
      heartbeatMs: 5,
      watchdog: { unhealthyAfterMs: 1_000, onUnhealthy },
    });
    const { deps } = testDeps();

    await channel.start(deps);
    await flush();

    currentTime = 500;
    await flush(30);
    expect(onUnhealthy).not.toHaveBeenCalled();

    currentTime = 1_500;
    await flush(30);
    expect(onUnhealthy).toHaveBeenCalledTimes(1);

    // Still unhealthy long after crossing the threshold - must not re-fire.
    currentTime = 10_000;
    await flush(30);
    expect(onUnhealthy).toHaveBeenCalledTimes(1);

    // Reconnect, then go unhealthy again - the watchdog must rearm.
    sockets[0]?.ev.emit("connection.update", { connection: "open" });
    sockets[0]?.ev.emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 500 } } },
    });

    currentTime = 11_001;
    await flush(30);
    expect(onUnhealthy).toHaveBeenCalledTimes(2);
  });

  test("without onUnhealthy configured, a routine reconnect never logs at error level", async () => {
    const sockets: FakeSocket[] = [];
    let currentTime = 0;
    const errors: unknown[] = [];
    const logger: Logger = {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: (message: unknown) => errors.push(message),
    };
    const channel = createWhatsAppChannel({
      sessionSecret: "test-session-secret-value",
      loadBaileys: async () => fakeBaileysModule({ registered: true, sockets }),
      schedule: () => undefined,
      now: () => currentTime,
      heartbeatMs: 5,
      logger,
    });
    const { deps } = testDeps();

    await channel.start(deps);
    await flush();

    // Still well within the bounded interval - a session that is merely
    // connecting (or briefly reconnecting) must not read as an outage yet.
    currentTime = 1_000;
    await flush(30);
    expect(errors).toHaveLength(0);
  });

  test("without onUnhealthy configured, a session stuck unhealthy gets a bounded, repeating error log", async () => {
    const sockets: FakeSocket[] = [];
    let currentTime = 0;
    const errors: unknown[] = [];
    const logger: Logger = {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: (message: unknown) => errors.push(message),
    };
    const channel = createWhatsAppChannel({
      sessionSecret: "test-session-secret-value",
      loadBaileys: async () => fakeBaileysModule({ registered: true, sockets }),
      schedule: () => undefined,
      now: () => currentTime,
      heartbeatMs: 5,
      logger,
    });
    const { deps } = testDeps();

    await channel.start(deps);
    await flush();
    expect(errors).toHaveLength(0);

    // Past the bounded interval, still never connected - first log fires.
    currentTime = 6 * 60 * 1000;
    await flush(30);
    const firstCount = errors.length;
    expect(firstCount).toBeGreaterThan(0);
    expect(String(errors[0])).toMatch(/unhealthy/);

    // Immediately after - no repeat yet.
    currentTime += 1_000;
    await flush(30);
    expect(errors.length).toBe(firstCount);

    // A full interval later - logs again.
    currentTime += 6 * 60 * 1000;
    await flush(30);
    expect(errors.length).toBeGreaterThan(firstCount);
  });

  test("watchdog treats waiting_for_lease as unhealthy too - a lease held elsewhere still trips it", async () => {
    let currentTime = 0;
    const onUnhealthy = mock(() => undefined);
    // Another instance already holds this session's lease, so every acquire
    // attempt this channel makes is denied and it stays in waiting_for_lease.
    const leaseStore = fakeLeaseStore();
    await leaseStore.tryAcquire("default", "other-instance", Date.now(), 100_000);
    const channel = createWhatsAppChannel({
      sessionSecret: "test-session-secret-value",
      loadBaileys: async () => fakeBaileysModule({ registered: true, sockets: [] }),
      schedule: () => undefined,
      leaseStore,
      authStore: fakeAuthKV(),
      now: () => currentTime,
      heartbeatMs: 5,
      watchdog: { unhealthyAfterMs: 1_000, onUnhealthy },
    });
    const { deps } = testDeps();
    (deps as { db: unknown }).db = undefined;

    await channel.start(deps);
    await flush();
    expect(channel.getStatus()[0]?.state).toBe("waiting_for_lease");

    currentTime = 1_500;
    await flush(30);
    expect(onUnhealthy).toHaveBeenCalledTimes(1);
  });
});
