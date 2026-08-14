import { describe, expect, test } from "bun:test";
import {
  decidePairingClose,
  MAX_PAIRING_RECONNECTS,
  type PairingConnectionUpdate,
  type PairingSocket,
  pairingReconnectDelayMs,
  RESTART_REQUIRED_STATUS,
  runPairing,
} from "./pairing";

const LOGGED_OUT = 401;

describe("pairingReconnectDelayMs", () => {
  test("answers a 515 restart at once — the phone is waiting on the link", () => {
    expect(pairingReconnectDelayMs(RESTART_REQUIRED_STATUS, 1)).toBe(500);
    expect(pairingReconnectDelayMs(RESTART_REQUIRED_STATUS, 7)).toBe(500);
  });

  test("backs off other closes in seconds, capped", () => {
    expect(pairingReconnectDelayMs(428, 1)).toBe(2_000);
    expect(pairingReconnectDelayMs(428, 2)).toBe(4_000);
    expect(pairingReconnectDelayMs(undefined, 3)).toBe(8_000);
    expect(pairingReconnectDelayMs(undefined, 12)).toBe(8_000);
  });
});

describe("decidePairingClose", () => {
  test("a 515 close reconnects rather than failing the pairing", () => {
    expect(
      decidePairingClose({
        statusCode: RESTART_REQUIRED_STATUS,
        loggedOutCode: LOGGED_OUT,
        attempts: 0,
        maxAttempts: 12,
      }),
    ).toEqual({ kind: "reconnect", attempt: 1, delayMs: 500 });
  });

  test("a logout is fatal even with attempts left", () => {
    expect(
      decidePairingClose({
        statusCode: LOGGED_OUT,
        loggedOutCode: LOGGED_OUT,
        attempts: 0,
        maxAttempts: 12,
      }),
    ).toEqual({ kind: "fatal", reason: "loggedOut" });
  });

  test("gives up once the attempt budget is spent", () => {
    expect(
      decidePairingClose({
        statusCode: RESTART_REQUIRED_STATUS,
        loggedOutCode: LOGGED_OUT,
        attempts: 12,
        maxAttempts: 12,
      }),
    ).toEqual({ kind: "fatal", reason: "exhausted" });
  });
});

/** A socket whose `connection.update` and `creds.update` listeners the test drives by hand. */
function fakeSocket(overrides: Partial<PairingSocket> = {}) {
  const listeners: Record<string, ((update: PairingConnectionUpdate) => void)[]> = {};
  const ended: true[] = [];
  const sock: PairingSocket = {
    ev: {
      on: (event, listener) => {
        const registered = listeners[event] ?? [];
        registered.push(listener);
        listeners[event] = registered;
      },
    },
    user: { id: "44700000000:1@s.whatsapp.net" },
    requestPairingCode: async () => "ABCD-EFGH",
    end: () => ended.push(true),
    ...overrides,
  };
  const fire = (event: string, update: PairingConnectionUpdate) => {
    for (const listener of [...(listeners[event] ?? [])]) listener(update);
  };
  return {
    sock,
    get ended() {
      return ended.length > 0;
    },
    emit: (update: PairingConnectionUpdate) => fire("connection.update", update),
    /** Baileys mutates the creds in place and then just says "they changed". */
    emitCreds: () => fire("creds.update", {}),
  };
}

/**
 * The stored (encrypted) session row plus the per-socket credentials Baileys
 * mutates — the shape `useTursoAuthState` hands the CLI. Writes are not
 * instant, which is the whole point: a reconnect that re-reads too early sees
 * a session that is not registered yet.
 */
function fakeSession() {
  const stored = { creds: { registered: false } };
  return {
    stored,
    /** What a fresh `useTursoAuthState` gives an attempt: a snapshot plus its saver. */
    open() {
      const creds = { ...stored.creds };
      return {
        creds,
        saveCreds: async () => {
          await tick();
          stored.creds = { ...creds };
        },
      };
    },
  };
}

/** Real timers (so ordering matches production) with the waiting compressed away. */
const fastScheduler = (fn: () => void, ms: number) => {
  setTimeout(fn, Math.min(ms, 1));
};

async function until(condition: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (condition()) return;
    await tick();
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Runs scheduled callbacks immediately, recording the delays that were asked for. */
function immediateScheduler() {
  const delays: number[] = [];
  return {
    delays,
    schedule: (fn: () => void, ms: number) => {
      delays.push(ms);
      fn();
    },
  };
}

/**
 * Holds scheduled callbacks until the test releases them — the production
 * timing an immediate scheduler papers over, where a dying socket keeps
 * emitting during the reconnect delay.
 */
function deferredScheduler() {
  const queued: (() => void)[] = [];
  return {
    schedule: (fn: () => void) => queued.push(fn),
    async flush(): Promise<void> {
      while (queued.length > 0) {
        queued.shift()?.();
        await tick();
      }
    },
  };
}

/** Lets `runPairing`'s async `connect` settle so the socket's listener is attached. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const closedWith = (statusCode: number): PairingConnectionUpdate => ({
  connection: "close",
  lastDisconnect: { error: { output: { statusCode } } },
});

describe("runPairing", () => {
  test("QR scan -> 515 -> auto-reconnect with stored creds -> open succeeds", async () => {
    const sockets = [fakeSocket(), fakeSocket()];
    const attempts: number[] = [];
    const statuses: string[] = [];
    const scheduler = immediateScheduler();

    const result = runPairing({
      connect: (attempt) => {
        attempts.push(attempt);
        return sockets[attempt].sock;
      },
      loggedOutCode: LOGGED_OUT,
      schedule: scheduler.schedule,
      onStatus: (message) => statuses.push(message),
    });

    await tick();
    // Scan registers the device; WhatsApp always bounces the socket with 515.
    sockets[0].emit(closedWith(RESTART_REQUIRED_STATUS));
    await tick();
    // The reconnected socket completes the link.
    sockets[1].emit({ connection: "open" });

    expect(await result).toEqual({ ok: true, userId: "44700000000:1@s.whatsapp.net" });
    expect(attempts).toEqual([0, 1]);
    expect(scheduler.delays).toEqual([500]);
    expect(statuses[0]).toContain("515");
  });

  test("a superseded socket still emitting during the reconnect delay cannot fail the run", async () => {
    const sockets = [fakeSocket(), fakeSocket()];
    const connects: number[] = [];
    const scheduler = deferredScheduler();

    const result = runPairing({
      connect: (attempt) => {
        connects.push(attempt);
        return sockets[attempt].sock;
      },
      loggedOutCode: LOGGED_OUT,
      schedule: scheduler.schedule,
    });

    await tick();
    sockets[0].emit(closedWith(RESTART_REQUIRED_STATUS));
    // The reconnect is still pending; the dying socket emits again — including
    // a logout, which would be fatal if it were still the current socket.
    sockets[0].emit(closedWith(LOGGED_OUT));
    sockets[0].emit(closedWith(RESTART_REQUIRED_STATUS));
    expect(sockets[0].ended).toBe(true); // superseded sockets are closed, not left writing

    await scheduler.flush();
    sockets[1].emit({ connection: "open" });

    expect(await result).toEqual({ ok: true, userId: "44700000000:1@s.whatsapp.net" });
    // One reconnect, not one per stale event.
    expect(connects).toEqual([0, 1]);
  });

  test("a logout ends the run without reconnecting", async () => {
    const sockets = [fakeSocket()];
    let connects = 0;
    const result = runPairing({
      connect: () => {
        connects++;
        return sockets[0].sock;
      },
      loggedOutCode: LOGGED_OUT,
      schedule: immediateScheduler().schedule,
    });

    await tick();
    sockets[0].emit(closedWith(LOGGED_OUT));

    expect(await result).toMatchObject({ ok: false, reason: "loggedOut" });
    expect(connects).toBe(1);
  });

  test("bounded: repeated closes give up after maxAttempts and say so", async () => {
    const scheduler = immediateScheduler();
    let connects = 0;
    let emit: ((update: PairingConnectionUpdate) => void) | undefined;

    const result = runPairing({
      connect: () => {
        connects++;
        const socket = fakeSocket();
        emit = socket.emit;
        // Each new socket closes immediately, exactly as a broken pairing does.
        setTimeout(() => emit?.(closedWith(RESTART_REQUIRED_STATUS)), 0);
        return socket.sock;
      },
      loggedOutCode: LOGGED_OUT,
      maxAttempts: 3,
      schedule: scheduler.schedule,
    });

    expect(await result).toMatchObject({ ok: false, reason: "exhausted" });
    expect((await result) as { message: string }).toMatchObject({
      message: expect.stringContaining("3 reconnect attempts"),
    });
    expect(connects).toBe(4); // first attempt + 3 reconnects
  });

  test("pairing-code mode requests the code once, not again on reconnect", async () => {
    const codes: string[] = [];
    const sockets = [fakeSocket(), fakeSocket()];
    let requests = 0;
    for (const socket of sockets) {
      socket.sock.requestPairingCode = async () => {
        requests++;
        return "ABCD-EFGH";
      };
    }

    const result = runPairing({
      connect: (attempt) => sockets[attempt].sock,
      loggedOutCode: LOGGED_OUT,
      phoneNumber: "447700900123",
      requestCodeDelayMs: 0,
      schedule: immediateScheduler().schedule,
      onPairingCode: (code) => codes.push(code),
    });

    await tick();
    sockets[0].emit(closedWith(428));
    await tick();
    sockets[1].emit({ connection: "open" });

    expect(await result).toMatchObject({ ok: true });
    expect(codes).toEqual(["ABCD-EFGH"]);
    expect(requests).toBe(1);
  });

  test("QR mode renders the code and survives a render failure", async () => {
    const rendered: string[] = [];
    const statuses: string[] = [];
    const socket = fakeSocket();

    const result = runPairing({
      connect: () => socket.sock,
      loggedOutCode: LOGGED_OUT,
      schedule: immediateScheduler().schedule,
      onQr: (qr) => {
        rendered.push(qr);
        throw new Error("no tty");
      },
      onStatus: (message) => statuses.push(message),
    });

    await tick();
    socket.emit({ qr: "2@qr-payload" });
    await tick();
    socket.emit({ connection: "open" });

    expect(await result).toMatchObject({ ok: true });
    expect(rendered).toEqual(["2@qr-payload"]);
    expect(statuses.some((s) => s.includes("QR render failed"))).toBe(true);
  });

  test("a handler error is surfaced via onStatus and ends the run, instead of hanging forever", async () => {
    const statuses: string[] = [];
    const socket = fakeSocket();

    const result = runPairing({
      connect: () => socket.sock,
      loggedOutCode: LOGGED_OUT,
      schedule: immediateScheduler().schedule,
      onStatus: (message) => statuses.push(message),
    });

    await tick();
    // A malformed update (e.g. a Boom shape Baileys didn't document) throws
    // while the handler reads it, before a reconnect gets scheduled — that
    // must fail the run loudly, not leave the CLI waiting on a dead socket.
    const poisoned = { connection: "close" } as PairingConnectionUpdate;
    Object.defineProperty(poisoned, "lastDisconnect", {
      get() {
        throw new Error("malformed disconnect payload");
      },
    });
    socket.emit(poisoned);

    expect(await result).toMatchObject({ ok: false, reason: "error" });
    expect(statuses.some((s) => s.includes("connection.update handler error"))).toBe(true);
    expect(statuses.some((s) => s.includes("malformed disconnect payload"))).toBe(true);
  });

  test("a superseded socket that fails to close does not block the reconnect", async () => {
    const statuses: string[] = [];
    const sockets = [
      fakeSocket({
        end: () => {
          throw new Error("socket already destroyed");
        },
      }),
      fakeSocket(),
    ];

    const result = runPairing({
      connect: (attempt) => sockets[attempt].sock,
      loggedOutCode: LOGGED_OUT,
      schedule: immediateScheduler().schedule,
      onStatus: (message) => statuses.push(message),
    });

    await tick();
    sockets[0].emit(closedWith(RESTART_REQUIRED_STATUS));
    await tick();
    sockets[1].emit({ connection: "open" });

    expect(statuses.some((s) => s.includes("Failed to close the previous socket"))).toBe(true);
    expect(await result).toMatchObject({ ok: true });
  });

  test("a connect failure ends the run with the underlying error", async () => {
    const result = await runPairing({
      connect: () => {
        throw new Error("TURSO_URL unreachable");
      },
      loggedOutCode: LOGGED_OUT,
      schedule: immediateScheduler().schedule,
    });

    expect(result).toEqual({
      ok: false,
      reason: "error",
      message: "TURSO_URL unreachable",
    });
  });

  test("the default attempt budget is patient but finite", async () => {
    let connects = 0;
    let emit: ((update: PairingConnectionUpdate) => void) | undefined;

    const result = await runPairing({
      connect: () => {
        connects++;
        const socket = fakeSocket();
        emit = socket.emit;
        setTimeout(() => emit?.(closedWith(RESTART_REQUIRED_STATUS)), 0);
        return socket.sock;
      },
      loggedOutCode: LOGGED_OUT,
      schedule: immediateScheduler().schedule,
    });

    expect(result).toMatchObject({ ok: false, reason: "exhausted" });
    expect(connects).toBe(MAX_PAIRING_RECONNECTS + 1);
  });
});

describe("runPairing credential persistence", () => {
  test("the registration written during the 515 window reaches storage before the reconnect re-reads it", async () => {
    const session = fakeSession();
    const sockets = [fakeSocket(), fakeSocket()];
    const opened: { registered: boolean }[] = [];

    const result = runPairing({
      connect: (attempt) => {
        const { creds, saveCreds } = session.open();
        opened.push(creds);
        return { sock: sockets[attempt].sock, saveCreds };
      },
      loggedOutCode: LOGGED_OUT,
      verifyRegistered: () => session.stored.creds.registered,
      registeredPollMs: 5,
      registeredTimeoutMs: 2_000,
      schedule: fastScheduler,
    });

    await tick();
    // The scan registers the device: Baileys flips the flag on the socket's
    // creds and announces it, and WhatsApp bounces the socket with 515 before
    // the write has landed.
    opened[0].registered = true;
    sockets[0].emitCreds();
    sockets[0].emit(closedWith(RESTART_REQUIRED_STATUS));

    await until(() => opened.length === 2, "the reconnect");
    expect(opened[1].registered).toBe(true);

    sockets[1].emit({ connection: "open" });
    expect(await result).toEqual({ ok: true, userId: "44700000000:1@s.whatsapp.net" });
    expect(session.stored.creds.registered).toBe(true);
  });

  test("success waits for a creds.update that only lands after the connection opens", async () => {
    const session = fakeSession();
    const sockets = [fakeSocket(), fakeSocket()];
    const opened: { registered: boolean }[] = [];
    const statuses: string[] = [];

    const result = runPairing({
      connect: (attempt) => {
        const { creds, saveCreds } = session.open();
        opened.push(creds);
        return { sock: sockets[attempt].sock, saveCreds };
      },
      loggedOutCode: LOGGED_OUT,
      verifyRegistered: () => session.stored.creds.registered,
      registeredPollMs: 5,
      registeredTimeoutMs: 2_000,
      schedule: fastScheduler,
      onStatus: (message) => statuses.push(message),
    });

    await tick();
    sockets[0].emit(closedWith(RESTART_REQUIRED_STATUS));
    await until(() => opened.length === 2, "the reconnect");

    sockets[1].emit({ connection: "open" });
    await tick();
    // Nothing usable is stored yet, so the run must still be waiting.
    expect(session.stored.creds.registered).toBe(false);

    opened[1].registered = true;
    sockets[1].emitCreds();

    expect(await result).toMatchObject({ ok: true });
    expect(session.stored.creds.registered).toBe(true);
    expect(statuses.some((s) => s.includes("waiting for the session"))).toBe(true);
  });

  test("a link that never registers fails loudly instead of reporting a session the server cannot use", async () => {
    const session = fakeSession();
    const socket = fakeSocket();

    const result = runPairing({
      connect: () => {
        const { saveCreds } = session.open();
        return { sock: socket.sock, saveCreds };
      },
      loggedOutCode: LOGGED_OUT,
      verifyRegistered: () => session.stored.creds.registered,
      registeredPollMs: 5,
      registeredTimeoutMs: 30,
      schedule: fastScheduler,
    });

    await tick();
    socket.emit({ connection: "open" });

    expect(await result).toMatchObject({ ok: false, reason: "unregistered" });
    expect((await result) as { message: string }).toMatchObject({
      message: expect.stringContaining("never read back as registered"),
    });
  });

  test("a superseded socket's creds.update cannot stamp the live session back down", async () => {
    const session = fakeSession();
    const sockets = [fakeSocket(), fakeSocket()];
    const opened: { registered: boolean }[] = [];

    const result = runPairing({
      connect: (attempt) => {
        const { creds, saveCreds } = session.open();
        opened.push(creds);
        return { sock: sockets[attempt].sock, saveCreds };
      },
      loggedOutCode: LOGGED_OUT,
      verifyRegistered: () => session.stored.creds.registered,
      registeredPollMs: 5,
      registeredTimeoutMs: 50,
      schedule: fastScheduler,
    });

    await tick();
    sockets[0].emit(closedWith(RESTART_REQUIRED_STATUS));
    await until(() => opened.length === 2, "the reconnect");

    opened[1].registered = true;
    sockets[1].emitCreds();
    // The dying socket announces its own (pre-registration) creds afterwards.
    sockets[0].emitCreds();
    sockets[1].emit({ connection: "open" });

    expect(await result).toMatchObject({ ok: true });
    expect(session.stored.creds.registered).toBe(true);
  });

  test("a failing save is reported and does not crash the run", async () => {
    const socket = fakeSocket();
    const statuses: string[] = [];

    const result = runPairing({
      connect: () => ({
        sock: socket.sock,
        saveCreds: async () => {
          throw new Error("turso unreachable");
        },
      }),
      loggedOutCode: LOGGED_OUT,
      verifyRegistered: () => false,
      registeredPollMs: 5,
      registeredTimeoutMs: 30,
      schedule: fastScheduler,
      onStatus: (message) => statuses.push(message),
    });

    await tick();
    socket.emitCreds();
    socket.emit({ connection: "open" });

    expect(await result).toMatchObject({ ok: false, reason: "unregistered" });
    expect(statuses.some((s) => s.includes("turso unreachable"))).toBe(true);
  });
});
