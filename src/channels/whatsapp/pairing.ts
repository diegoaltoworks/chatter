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
 */

/** Baileys' "restart required" — emitted immediately after a QR scan registers the device. */
export const RESTART_REQUIRED_STATUS = 515;

/** Bounded so a genuinely broken pairing terminates instead of looping forever. */
export const MAX_PAIRING_RECONNECTS = 12;

const PAIRING_RECONNECT_DELAY_MS = 2_000;
const PAIRING_RECONNECT_MAX_DELAY_MS = 8_000;
const RESTART_REQUIRED_DELAY_MS = 500;

/**
 * Backoff between pairing attempts. Deliberately tighter than the transport's
 * 5s→10min ladder (`reconnectDelayMs`): that one protects a long-lived
 * connection from hammering WhatsApp during an outage, whereas here a human is
 * holding a phone that gives the link a limited window — a 515 restart has to
 * be answered at once, and other bounces within seconds.
 */
export function pairingReconnectDelayMs(statusCode: number | undefined, attempt: number): number {
  if (statusCode === RESTART_REQUIRED_STATUS) return RESTART_REQUIRED_DELAY_MS;
  return Math.min(
    PAIRING_RECONNECT_DELAY_MS * 2 ** Math.max(0, attempt - 1),
    PAIRING_RECONNECT_MAX_DELAY_MS,
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
    on: (event: "connection.update", listener: (update: PairingConnectionUpdate) => void) => void;
  };
  user?: { id?: string } | null;
  requestPairingCode: (phoneNumber: string) => Promise<string>;
  /** Closes a superseded socket so it stops writing to the session. */
  end?: (error?: Error) => void;
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
  | { ok: false; reason: "loggedOut" | "exhausted" | "error"; message: string };

export interface PairingRunDeps {
  /**
   * Opens a socket for `attempt` (0 = first). MUST reuse the stored
   * credentials — a reconnect that starts from blank creds shows a fresh QR
   * instead of finishing the link the phone is waiting on.
   */
  connect: (attempt: number) => PairingSocket | Promise<PairingSocket>;
  loggedOutCode: number;
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
        settle({ ok: true, userId: sock.user?.id });
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
        sock.end?.();
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
      let sock: PairingSocket;
      try {
        sock = await deps.connect(attempt);
      } catch (error) {
        settle({ ok: false, reason: "error", message: describeError(error) });
        return;
      }

      sock.ev.on("connection.update", (update) => {
        if (mine !== generation || settled) return;
        void handleUpdate(update, sock);
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
