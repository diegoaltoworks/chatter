/**
 * Pairing loop for the `wa-pair` CLI — the transport-independent half, kept
 * out of the bin so it can be unit-tested against a faked socket.
 *
 * Both pairing modes close the socket mid-flow as a matter of course:
 *
 * - QR mode: the moment a scan registers the device, WhatsApp ALWAYS closes
 *   with 515 ("restart required"). The link only completes if the client comes
 *   straight back with the SAME credentials it just registered — the phone is
 *   sitting on "linking" waiting for exactly that. Exiting there (or wiping
 *   creds and starting over) fails the pairing every time.
 * - Pairing-code mode: the socket bounces while the code is being typed.
 *
 * So a close during pairing is normal, not fatal: reconnect with stored creds,
 * bounded, until `open` confirms the link. Only an explicit logout or running
 * out of attempts ends the run.
 *
 * Credentials are persisted by this loop rather than by the caller's socket
 * wiring, because the saves have to be ordered against the reconnects: the
 * registration that a 515 interrupts is only useful if it reaches storage
 * BEFORE the next attempt re-reads the session, and the flag that marks the
 * session usable (`registered`) is often written by a `creds.update` that
 * lands around or after `open`. A run therefore ends successfully only once
 * the caller confirms — by reading storage back — that the stored session is
 * registered.
 */

import { exponentialBackoffMs } from "../backoff";

/** Baileys' "restart required" — emitted immediately after a QR scan registers the device. */
export const RESTART_REQUIRED_STATUS = 515;

/** Bounded so a genuinely broken pairing terminates instead of looping forever. */
export const MAX_PAIRING_RECONNECTS = 12;

const PAIRING_RECONNECT_DELAY_MS = 2_000;
const PAIRING_RECONNECT_MAX_DELAY_MS = 8_000;
const RESTART_REQUIRED_DELAY_MS = 500;

/**
 * How long to keep the freshly-opened socket alive waiting for the stored
 * session to read back as registered. Generous: the flag arrives on WhatsApp's
 * schedule, and giving up early is exactly the bug this window exists to fix.
 */
const REGISTERED_CONFIRM_TIMEOUT_MS = 15_000;
const REGISTERED_CONFIRM_POLL_MS = 500;

/**
 * Backoff between pairing attempts. Deliberately tighter than the transport's
 * 5s→10min ladder (`reconnectDelayMs`): that one protects a long-lived
 * connection from hammering WhatsApp during an outage, whereas here a human is
 * holding a phone that gives the link a limited window — a 515 restart has to
 * be answered at once, and other bounces within seconds.
 */
export function pairingReconnectDelayMs(statusCode: number | undefined, attempt: number): number {
  if (statusCode === RESTART_REQUIRED_STATUS) return RESTART_REQUIRED_DELAY_MS;
  return exponentialBackoffMs(
    PAIRING_RECONNECT_DELAY_MS,
    PAIRING_RECONNECT_MAX_DELAY_MS,
    attempt - 1,
  );
}

export type PairingCloseAction =
  | { kind: "reconnect"; attempt: number; delayMs: number }
  | { kind: "fatal"; reason: "loggedOut" | "exhausted" };

export interface PairingCloseInput {
  statusCode?: number;
  /** `DisconnectReason.loggedOut` from the loaded Baileys build. */
  loggedOutCode: number;
  /** Reconnects already spent. */
  attempts: number;
  maxAttempts: number;
}

/**
 * Pure: what to do about a `connection: "close"` during pairing. A logout is
 * final (the credentials just got revoked — retrying re-revokes them); every
 * other close is transient until the attempt budget runs out.
 */
export function decidePairingClose(input: PairingCloseInput): PairingCloseAction {
  if (input.statusCode === input.loggedOutCode) return { kind: "fatal", reason: "loggedOut" };
  if (input.attempts >= input.maxAttempts) return { kind: "fatal", reason: "exhausted" };
  const attempt = input.attempts + 1;
  return {
    kind: "reconnect",
    attempt,
    delayMs: pairingReconnectDelayMs(input.statusCode, attempt),
  };
}

/** The slice of a Baileys socket the pairing loop uses. */
export interface PairingSocket {
  ev: {
    on: (
      event: "connection.update" | "creds.update",
      listener: (update: PairingConnectionUpdate) => void,
    ) => void;
  };
  user?: { id?: string } | null;
  requestPairingCode: (phoneNumber: string) => Promise<string>;
  /** Closes a superseded socket so it stops writing to the session. */
  end?: (error?: Error) => void;
}

/**
 * A socket plus the way to persist the credentials it mutates. Returning the
 * pair (instead of wiring `creds.update` at the call site) lets the loop order
 * saves against reconnects — see the module comment.
 */
export interface PairingAttempt {
  sock: PairingSocket;
  /** Writes this attempt's credentials to storage; called on every `creds.update`. */
  saveCreds?: () => Promise<void>;
}

/** Baileys rejects with Boom objects; keep whatever the payload says rather than `undefined`. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface PairingConnectionUpdate {
  connection?: string;
  qr?: string;
  lastDisconnect?: { error?: unknown } | null;
}

export type PairingResult =
  | { ok: true; userId?: string }
  | { ok: false; reason: "loggedOut" | "exhausted" | "error" | "unregistered"; message: string };

export interface PairingRunDeps {
  /**
   * Opens a socket for `attempt` (0 = first). MUST re-read the stored
   * credentials — a reconnect that starts from blank creds shows a fresh QR
   * instead of finishing the link the phone is waiting on.
   */
  connect: (
    attempt: number,
  ) => PairingSocket | PairingAttempt | Promise<PairingSocket | PairingAttempt>;
  loggedOutCode: number;
  /**
   * Reads the STORED session back and answers whether it is registered — i.e.
   * whether the server would find a usable session. Polled after `open` while
   * late `creds.update` events are still being persisted; a run that never
   * sees `true` fails with reason `unregistered` rather than claiming success
   * over a session nothing can use. Omit to skip the check.
   */
  verifyRegistered?: () => boolean | Promise<boolean>;
  /** How long to wait for the stored session to read back registered. */
  registeredTimeoutMs?: number;
  /** Gap between those reads. */
  registeredPollMs?: number;
  /** Digits-only number for pairing-code mode; omit for QR mode. */
  phoneNumber?: string;
  maxAttempts?: number;
  /** Delay before asking for a pairing code, giving the socket time to handshake. */
  requestCodeDelayMs?: number;
  /** Overridable for tests; defaults to `setTimeout`. */
  schedule?: (fn: () => void, ms: number) => void;
  /** Renders the QR (QR mode only). A throw is reported, never swallowed. */
  onQr?: (qr: string) => void | Promise<void>;
  onPairingCode?: (code: string) => void;
  /** Progress lines for the operator (reconnect notices, QR render failures). */
  onStatus?: (message: string) => void;
}

/**
 * Runs one pairing to a verdict: resolves `{ ok: true }` when the connection
 * reaches `open` (the link is live), or `{ ok: false }` on logout, attempt
 * exhaustion, or a connect/pairing-code failure. Never rejects.
 */
export function runPairing(deps: PairingRunDeps): Promise<PairingResult> {
  const maxAttempts = deps.maxAttempts ?? MAX_PAIRING_RECONNECTS;
  const schedule =
    deps.schedule ??
    ((fn: () => void, ms: number) => {
      setTimeout(fn, ms);
    });

  return new Promise<PairingResult>((resolve) => {
    let attempts = 0;
    let generation = 0;
    let codeRequested = false;
    let settled = false;

    const settle = (result: PairingResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const status = (message: string) => deps.onStatus?.(message);

    const wait = (ms: number) =>
      new Promise<void>((resolve) => {
        schedule(() => resolve(), ms);
      });

    // Saves are chained rather than fired in parallel: they all write the same
    // session row, so the last writer wins and out-of-order writes lose the
    // registration.
    let saves: Promise<void> = Promise.resolve();

    const queueSave = (saveCreds: () => Promise<void>) => {
      saves = saves.then(saveCreds).catch((error) => {
        status(`Failed to save the session credentials: ${describeError(error)}`);
      });
    };

    /** Resolves once every save requested so far — including any queued while waiting — has landed. */
    const flushSaves = async (): Promise<void> => {
      let awaited: Promise<void> | undefined;
      while (awaited !== saves) {
        awaited = saves;
        await awaited;
      }
    };

    /**
     * Holds the open socket until storage confirms the session is registered,
     * flushing between reads so a `creds.update` that lands after `open` is
     * both persisted and seen.
     */
    const confirmRegistered = async (): Promise<boolean> => {
      await flushSaves();
      const verify = deps.verifyRegistered;
      if (!verify) return true;
      const pollMs = deps.registeredPollMs ?? REGISTERED_CONFIRM_POLL_MS;
      const polls = Math.max(
        1,
        Math.ceil((deps.registeredTimeoutMs ?? REGISTERED_CONFIRM_TIMEOUT_MS) / pollMs),
      );
      for (let poll = 0; poll < polls; poll++) {
        if (await verify()) return true;
        if (poll === polls - 1) break;
        if (poll === 0)
          status("Link is open — waiting for the session to be saved as registered...");
        await wait(pollMs);
        await flushSaves();
      }
      return false;
    };

    const requestCode = async (sock: PairingSocket) => {
      if (settled || codeRequested || !deps.phoneNumber) return;
      try {
        const code = await sock.requestPairingCode(deps.phoneNumber);
        codeRequested = true;
        deps.onPairingCode?.(code);
      } catch (error) {
        settle({
          ok: false,
          reason: "error",
          message: `Failed to request pairing code: ${describeError(error)}`,
        });
      }
    };

    const handleUpdate = async (update: PairingConnectionUpdate, sock: PairingSocket) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr && !deps.phoneNumber && deps.onQr) {
        // A render failure must not kill the run: the code is still valid and
        // the operator can fall back to pairing-code mode.
        try {
          await deps.onQr(qr);
        } catch (error) {
          status(`QR render failed: ${describeError(error)}`);
        }
      }

      if (connection === "open") {
        if (await confirmRegistered()) {
          settle({ ok: true, userId: sock.user?.id });
        } else {
          settle({
            ok: false,
            reason: "unregistered",
            message:
              "The link opened but the stored session never read back as registered, so the server " +
              "would not find it. Run wa-pair again (add --reset to pair from scratch).",
          });
        }
        return;
      }

      if (connection === "close") {
        const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output
          ?.statusCode;
        const action = decidePairingClose({
          statusCode,
          loggedOutCode: deps.loggedOutCode,
          attempts,
          maxAttempts,
        });

        if (action.kind === "fatal") {
          settle({
            ok: false,
            reason: action.reason,
            message:
              action.reason === "loggedOut"
                ? "Pairing rejected (logged out). Run wa-pair again for a fresh code."
                : `Gave up after ${maxAttempts} reconnect attempts (last close: ${statusCode ?? "?"}). Run wa-pair again.`,
          });
          return;
        }

        attempts = action.attempt;
        // Supersede HERE, not when the replacement socket opens: this one is
        // done, and a dying socket can emit again (a second close, a logout)
        // during the reconnect delay. Counting those would fail the pairing or
        // fan out into two live sockets writing the same session row.
        generation += 1;
        try {
          sock.end?.();
        } catch (error) {
          // A failure closing the superseded socket must not block the
          // reconnect that's about to happen — that would silently stall a
          // pairing that's otherwise fine.
          status(`Failed to close the previous socket: ${describeError(error)}`);
        }
        status(
          statusCode === RESTART_REQUIRED_STATUS
            ? `Registered — WhatsApp asked for a restart (515). Reconnecting to finish the link (${action.attempt}/${maxAttempts})...`
            : `Connection closed (${statusCode ?? "?"}) — reconnecting with the stored session (${action.attempt}/${maxAttempts})...`,
        );
        schedule(() => void attach(), action.delayMs);
      }
    };

    const attach = async () => {
      if (settled) return;
      const mine = generation;
      const attempt = attempts;
      // `connect` re-reads the stored session, so everything the superseded
      // socket wrote has to be in storage first — above all the registration
      // that the 515 close interrupts.
      await flushSaves();
      if (settled) return;
      let sock: PairingSocket;
      let saveCreds: (() => Promise<void>) | undefined;
      try {
        const opened = await deps.connect(attempt);
        if ("sock" in opened) {
          sock = opened.sock;
          saveCreds = opened.saveCreds;
        } else {
          sock = opened;
        }
      } catch (error) {
        settle({ ok: false, reason: "error", message: describeError(error) });
        return;
      }

      if (saveCreds) {
        const save = saveCreds;
        sock.ev.on("creds.update", () => {
          // A superseded socket must not write its own (older) credentials
          // over the live socket's — that is how a registered session gets
          // stamped back down to unregistered.
          if (settled || mine !== generation) return;
          queueSave(save);
        });
      }

      sock.ev.on("connection.update", (update) => {
        if (mine !== generation || settled) return;
        // A throw here means the update was never fully handled — in
        // particular a close that never got to `schedule()` a reconnect.
        // Surface it AND end the run rather than leaving a dead socket the
        // CLI silently waits on forever.
        handleUpdate(update, sock).catch((error) => {
          const message = `connection.update handler error: ${describeError(error)}`;
          status(message);
          settle({ ok: false, reason: "error", message });
        });
      });

      if (deps.phoneNumber && !codeRequested) {
        schedule(() => {
          if (mine !== generation) return;
          void requestCode(sock);
        }, deps.requestCodeDelayMs ?? 3_000);
      }
    };

    void attach();
  });
}
