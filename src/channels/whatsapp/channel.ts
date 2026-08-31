/**
 * WhatsApp web-client transport: a {@link Channel} that runs one Baileys
 * socket per configured session id (one WhatsApp number each), auth state
 * encrypted above an injectable {@link WaAuthKV} (defaults to a table in the
 * host's own database, `deps.db` - no second connection opened), and a
 * deploy lease behind an injectable `WaLeaseStore` so two overlapping
 * instances can never hold the same session's socket at once (WhatsApp
 * treats a second connection as a takeover and logs the first one out).
 *
 * Message INTERPRETATION — mention/reply detection, allowlists, loop guards —
 * is deliberately not this module's job; it hands every raw inbound message
 * to `config.onMessage` and lets the caller apply `./channels`' reply gates.
 * This module owns only the connection lifecycle and outbound sending.
 *
 * ToS note: Baileys is an unofficial WhatsApp client. Linking a number
 * carries a real ban risk — use a number you can afford to lose, and treat
 * this channel as opt-in, never a default.
 */

import type { WAMessage, WAMessageKey, WASocket } from "@whiskeysockets/baileys";
import { assertStrongSecret } from "../../auth/secretStrength";
import { createConsoleLogger, type Logger } from "../../core/logger";
import { exponentialBackoffMs } from "../backoff";
import type { Channel } from "../index";
import type { ChannelSender } from "../senders";
import type { AuthStateRuntime, WaAuthKV } from "./authState";
import { createTursoWaAuthKV, useAuthState } from "./authState";
import { type Baileys, loadBaileys as defaultLoadBaileys, silentLogger } from "./baileys";
import {
  createTursoWaLeaseStore,
  LEASE_HEARTBEAT_MS,
  LEASE_STALE_MS,
  LEASE_WAIT_MS,
  type WaLeaseStore,
} from "./lease";

const RECONNECT_DELAY_MS = 5_000;
const RECONNECT_MAX_DELAY_MS = 10 * 60 * 1000;
/** Bounds the default "still unhealthy" log to one line per session per
 * window, however long a session stays down - a silent 15h outage should
 * leave a grep-able trail, not a flood. */
const UNHEALTHY_LOG_INTERVAL_MS = 5 * 60 * 1000;

/** Exponential backoff: 5s, 10s, 20s ... capped at 10 minutes. Hammering
 * WhatsApp every few seconds during an outage or ban aggravates ban scoring. */
export function reconnectDelayMs(failures: number): number {
  return exponentialBackoffMs(RECONNECT_DELAY_MS, RECONNECT_MAX_DELAY_MS, failures);
}

/** Baileys rejects with Boom objects; keep whatever the payload says rather than `undefined`. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface WhatsAppMessageEvent {
  sessionId: string;
  sock: WASocket;
  message: WAMessage;
  /**
   * `sessionId`, but only when this channel is actually running more than
   * one endpoint (a custom `name`, or more than one configured `sessionId`)
   * - unset for a default single-session channel, so a host that hasn't
   * opted into multiple endpoints stays byte-identical to before endpointId
   * existed. See {@link ChannelMessage.endpointId}.
   */
  endpointId?: string;
}

/**
 * A session's connection state, derived from the same `connection.update`
 * and lease transitions the channel already reacts to - not a new event
 * source. `connecting` covers both the first connect after acquiring the
 * lease and every reconnect attempt; `waiting_for_lease` covers not
 * currently holding this session's lease, whether another instance holds it
 * or acquiring/renewing it is failing.
 */
export type WaConnectionState = "connected" | "connecting" | "waiting_for_lease" | "disconnected";

export interface WaSessionStatus {
  sessionId: string;
  state: WaConnectionState;
  /** `Date.now()`-style timestamp of the last state transition (not of the last read). */
  since: number;
  /** The most recent failure description; cleared once the session reconnects. */
  lastError?: string;
}

/**
 * Optional liveness escalation: `onUnhealthy` fires once a session has been
 * anything but `connected` for at least `unhealthyAfterMs`, and rearms the
 * moment it reconnects. That includes `waiting_for_lease` - legitimate
 * during a brief multi-instance deploy overlap, so size `unhealthyAfterMs`
 * comfortably above how long that overlap is expected to last, or an
 * instance that never wins the lease (a stuck rollout) will trip the
 * watchdog repeatedly. Off by default - an unconfigured host still gets a
 * bounded, grep-able error log while unhealthy (see `createWhatsAppChannel`'s
 * status checker), just no callback. A host can use `onUnhealthy` to alert,
 * or to `process.exit` so the platform restarts the container.
 */
export interface WhatsAppWatchdogConfig {
  unhealthyAfterMs: number;
  onUnhealthy?: (status: WaSessionStatus) => void;
}

export interface WhatsAppChannelConfig {
  /** Passphrase that encrypts auth state at rest (AES-256-GCM key material). Keep it stable across restarts and deploys — losing it means re-pairing. */
  sessionSecret: string;
  /** Channel and sender-registry name prefix (see {@link senderNameFor}). Override to run more than one WhatsApp channel in one process. @default "whatsapp" */
  name?: string;
  /** One Baileys connection per id, each a separate WhatsApp number. Defaults to `["default"]`, whose auth rows are unprefixed (a pre-multi-session deployment needs no migration). */
  sessionIds?: string[];
  /**
   * Called for every raw inbound message on every session. This module does
   * no interpretation of its own — no mention detection, no allowlists, no
   * loop guard — so replies belong entirely to the handler; pair it with
   * `./channels`' `decideChannelAction` and `isEffectivelyFromSelf`. A
   * throwing/rejecting handler is caught and logged, never left to crash the
   * socket's event loop.
   */
  onMessage?: (event: WhatsAppMessageEvent) => void | Promise<void>;
  now?: () => number;
  /** Overridable for tests; defaults to `setTimeout`. */
  schedule?: (fn: () => void, ms: number) => void;
  /** Overridable for tests, which fake the Baileys module instead of installing it; defaults to `loadBaileys` from `./baileys`. */
  loadBaileys?: () => Promise<Baileys>;
  staleMs?: number;
  heartbeatMs?: number;
  waitMs?: number;
  /** Logger for connection/lease lifecycle events. Default: a console logger writing to stderr. */
  logger?: Logger;
  /** Deploy-overlap lease. Defaults to a `wa_lease` table in `deps.db`; inject your own to run this channel without a libsql database (see docs/patterns/adding-a-store.md). */
  leaseStore?: WaLeaseStore;
  /** Baileys auth-state persistence, encrypted above this seam. Defaults to a `wa_auth` table in `deps.db`; inject your own to run this channel without a libsql database. */
  authStore?: WaAuthKV;
  /** Liveness escalation for a session stuck unhealthy. Off by default (see {@link WhatsAppWatchdogConfig}). */
  watchdog?: WhatsAppWatchdogConfig;
}

/** A live, leased session: what `stop()` (or losing the lease) must tear down. */
export interface WaSessionHandle {
  sock: { end: (error?: Error) => void };
  stopHeartbeat: () => void;
  release: () => Promise<void>;
}

/**
 * Tears down every session in `sessions`: stop renewing, close the socket,
 * THEN release the lease — releasing before the socket closes could let
 * another instance connect while this one is still on the wire. Sessions run
 * independently (`Promise.all`); one release rejecting must not block or skip
 * the rest.
 */
export async function shutdownWaSessions(sessions: Map<string, WaSessionHandle>): Promise<void> {
  await Promise.all(
    [...sessions.values()].map(async (handle) => {
      handle.stopHeartbeat();
      handle.sock.end(undefined);
      await handle.release().catch(() => undefined);
    }),
  );
}

/**
 * Claim a session for teardown, returning its handle - or `undefined` if
 * another path already claimed it. The lookup and the delete are synchronous,
 * so of two paths racing to give up the same session (a heartbeat that found
 * the lease taken over, a connect attempt that threw) exactly one wins. Only
 * the winner may schedule the next attempt: two winners would mean two retry
 * chains, both re-acquiring under this instance's own id (which the lease
 * store grants, being the same holder), and eventually two sockets for one
 * WhatsApp number.
 */
function claimSession(
  sessionId: string,
  sessions: Map<string, WaSessionHandle>,
): WaSessionHandle | undefined {
  const handle = sessions.get(sessionId);
  if (!handle) return undefined;
  sessions.delete(sessionId);
  return handle;
}

/** Gives up a session, resolving to whether this call was the one that claimed it. */
async function loseSession(
  sessionId: string,
  sessions: Map<string, WaSessionHandle>,
): Promise<boolean> {
  const handle = claimSession(sessionId, sessions);
  if (!handle) return false;
  await shutdownWaSessions(new Map([[sessionId, handle]]));
  return true;
}

export interface LeaseGatedConnectDeps {
  leaseStore: WaLeaseStore;
  instanceId: string;
  sessions: Map<string, WaSessionHandle>;
  isStopped: () => boolean;
  /** The actual Baileys connect — registers its own reconnect-on-close loop; this only gates its FIRST call. */
  connect: (sessionId: string) => Promise<void>;
  now?: () => number;
  staleMs?: number;
  heartbeatMs?: number;
  waitMs?: number;
  schedule?: (fn: () => void, ms: number) => void;
  logger?: Logger;
  /**
   * Recovery for a `connect` that threw, replacing the default (release the
   * session, re-check after `waitMs`). The channel injects one so a thrown
   * connect backs off on the same failure counter a closed connection uses
   * instead of re-attempting at a flat interval. Whatever it does, it must
   * end with another attempt scheduled: a session whose lease is held with
   * no live socket and nothing pending never recovers on its own.
   */
  onConnectFailed?: (sessionId: string, error: unknown) => void;
  /** Reports a connection-state transition, for the channel's status/watchdog seam. Optional - direct callers of `acquireSessionLease` in tests don't need it. */
  onStatusChange?: (sessionId: string, state: WaConnectionState, lastError?: string) => void;
}

/**
 * Acquire `sessionId`'s lease before connecting — two instances must never
 * run concurrent Baileys clients for the same session. Not holding it (or a
 * database blip while trying) means wait and re-check instead of connecting.
 * Once held, a heartbeat renews it for as long as the session runs; if a
 * heartbeat ever finds the lease gone (this instance went stale and another
 * took over), the session is torn down and this re-enters the same
 * wait-and-retry loop rather than staying connected alongside the new holder.
 *
 * Every failed connect attempt lands back here too, whether it threw on its
 * first try or on a reconnect: this loop is the only way a session recovers,
 * so an attempt that fails without leaving a socket behind (no socket, no
 * future "close" event) must re-enter it rather than stop at a log line.
 */
export async function acquireSessionLease(
  sessionId: string,
  deps: LeaseGatedConnectDeps,
): Promise<void> {
  const { leaseStore, instanceId, sessions, isStopped, connect } = deps;
  const now = deps.now ?? Date.now;
  const staleMs = deps.staleMs ?? LEASE_STALE_MS;
  const heartbeatMs = deps.heartbeatMs ?? LEASE_HEARTBEAT_MS;
  const waitMs = deps.waitMs ?? LEASE_WAIT_MS;
  const schedule = deps.schedule ?? ((fn, ms) => void setTimeout(fn, ms));
  const logger = deps.logger ?? createConsoleLogger();

  if (isStopped()) return;

  deps.onStatusChange?.(sessionId, "waiting_for_lease");

  const retry = () => {
    schedule(
      () =>
        void acquireSessionLease(sessionId, deps).catch((error) =>
          logger.error(`WhatsApp[${sessionId}]: lease re-check failed:`, error),
        ),
      waitMs,
    );
  };

  let acquired: boolean;
  try {
    acquired = await leaseStore.tryAcquire(sessionId, instanceId, now(), staleMs);
  } catch (error) {
    logger.warn(`WhatsApp[${sessionId}]: lease acquire failed, retrying:`, error);
    deps.onStatusChange?.(sessionId, "waiting_for_lease", describeError(error));
    retry();
    return;
  }
  if (!acquired) {
    logger.warn(`WhatsApp[${sessionId}]: lease held by another instance, re-checking later`);
    retry();
    return;
  }

  // Only re-check if this call is what actually gave the session up: a
  // connect attempt that threw at the same moment already owns the
  // recovery, and a second retry chain for one session is exactly what
  // the lease exists to prevent. Teardown finishes before the re-check
  // is scheduled because the socket here is a live one - it has to be
  // off the wire before anything reconnects.
  const demoteSelf = () => {
    void loseSession(sessionId, sessions).then((lost) => {
      if (lost) retry();
    });
  };

  // Tracks the last heartbeat that actually confirmed the lease, whether by
  // acquiring it just above or by a later renewal - so a heartbeat CALL that
  // rejects, or never settles at all (an unreachable Turso with no request
  // timeout can hang a `tryAcquire` indefinitely), can be distinguished from
  // one that resolves false. Only `tryAcquire` resolving false means another
  // instance holds the row; not hearing back at all means this instance
  // doesn't know who holds it, and staying quiet about that for longer than
  // `staleMs` is exactly the window in which the row goes stale and a
  // takeover can happen unnoticed. Checked at the top of every tick - not
  // just when a call rejects - so a hung call that never rejects still gets
  // caught by the next tick's check instead of stalling detection forever.
  let lastHeartbeatSuccessAt = now();

  const heartbeat = setInterval(() => {
    if (isStopped()) return;
    const attemptAt = now();
    const failingForMs = attemptAt - lastHeartbeatSuccessAt;
    if (failingForMs >= staleMs) {
      logger.error(
        `WhatsApp[${sessionId}]: lease heartbeats have been failing for ${failingForMs}ms, treating the lease as lost`,
      );
      deps.onStatusChange?.(
        sessionId,
        "disconnected",
        `lease heartbeats failing for ${failingForMs}ms`,
      );
      demoteSelf();
      return;
    }
    void leaseStore
      .tryAcquire(sessionId, instanceId, attemptAt, staleMs)
      .then((stillHeld) => {
        if (isStopped()) return;
        if (!stillHeld) {
          logger.error(`WhatsApp[${sessionId}]: lost the lease to another instance, disconnecting`);
          deps.onStatusChange?.(sessionId, "disconnected", "lost the lease to another instance");
          demoteSelf();
          return;
        }
        // The row is stamped with `attemptAt` (see `tryAcquire`'s SQL), not
        // whenever this promise happens to resolve - a slow-but-successful
        // renewal must not read as fresher than the row actually is.
        // `Math.max` guards against an earlier tick's call resolving after a
        // later one already recorded a more recent success.
        lastHeartbeatSuccessAt = Math.max(lastHeartbeatSuccessAt, attemptAt);
      })
      .catch((error) => logger.warn(`WhatsApp[${sessionId}]: lease heartbeat failed:`, error));
  }, heartbeatMs);
  if (typeof heartbeat === "object" && "unref" in heartbeat) heartbeat.unref();

  sessions.set(sessionId, {
    sock: { end: () => undefined },
    stopHeartbeat: () => clearInterval(heartbeat),
    release: () => leaseStore.release(sessionId, instanceId),
  });

  try {
    await connect(sessionId);
  } catch (error) {
    if (deps.onConnectFailed) {
      deps.onConnectFailed(sessionId, error);
      return;
    }
    logger.error(`WhatsApp[${sessionId}]: connect failed right after acquiring the lease:`, error);
    await loseSession(sessionId, sessions);
    retry();
  }
}

/** Sender-registry name for a session — the default session stays unprefixed so single-number deployments see a plain `"whatsapp"` name. */
export function senderNameFor(channelName: string, sessionId: string): string {
  return sessionId === "default" ? channelName : `${channelName}:${sessionId}`;
}

/** `ChannelSender.sendMedia`'s payload shape for this channel: a URL Baileys fetches itself, matching `./images`' own `{ image: { url } }` usage. A bare string is shorthand for the URL, the same convention `./telegram` and `./matrix` use. */
export interface WhatsAppMediaPayload {
  url: string;
  caption?: string;
}

/**
 * Turns the registry's opaque `sendMedia` payload into what `sock.sendMessage`
 * needs. `ChannelSender.sendMedia` types its payload as `unknown` (payload
 * shapes are transport-defined), so this is where that unknown is checked:
 * a malformed payload throws here, which the sender registry reports as
 * `false` rather than sending Baileys a `{ image: { url: undefined } }`.
 */
export function normalizeWaMediaPayload(payload: unknown): WhatsAppMediaPayload {
  const media: WhatsAppMediaPayload =
    typeof payload === "string" ? { url: payload } : (payload as WhatsAppMediaPayload);
  if (!media || typeof media !== "object" || typeof media.url !== "string" || !media.url) {
    throw new TypeError(
      `WhatsApp sendMedia payload must be a URL string or { url, caption? }, got: ${typeof payload}`,
    );
  }
  return media;
}

/** `createWhatsAppChannel`'s return type: the {@link Channel} SPI plus a way to poll per-session connection health without log-scraping. */
export interface WhatsAppChannel extends Channel {
  /** Per-session status, in the order `sessionIds` was configured. */
  getStatus(): WaSessionStatus[];
}

export function createWhatsAppChannel(config: WhatsAppChannelConfig): WhatsAppChannel {
  assertStrongSecret(config.sessionSecret, "WhatsApp sessionSecret (e.g. WA_SESSION_SECRET)");
  const channelName = config.name ?? "whatsapp";
  const sessionIds =
    config.sessionIds && config.sessionIds.length > 0 ? config.sessionIds : ["default"];
  // A custom name or more than one session id is what "opting into multiple
  // endpoints" looks like for this channel - see WhatsAppMessageEvent.endpointId.
  const multiEndpoint = config.name !== undefined || sessionIds.length > 1;
  const now = config.now ?? Date.now;
  const schedule = config.schedule ?? ((fn: () => void, ms: number) => void setTimeout(fn, ms));
  const staleMs = config.staleMs ?? LEASE_STALE_MS;
  const heartbeatMs = config.heartbeatMs ?? LEASE_HEARTBEAT_MS;
  const waitMs = config.waitMs ?? LEASE_WAIT_MS;
  const loadBaileys = config.loadBaileys ?? defaultLoadBaileys;

  let stopped = false;
  const instanceId = crypto.randomUUID();
  const sessions = new Map<string, WaSessionHandle>();
  const failureCounts = new Map<string, number>();
  const registeredSenderNames = new Map<string, string>();
  let senders: { unregister(name: string): void } | undefined;

  const statuses = new Map<string, WaSessionStatus>(
    sessionIds.map((id) => [id, { sessionId: id, state: "waiting_for_lease", since: now() }]),
  );
  // Tracks when each session's CURRENT unhealthy streak began - not the same
  // as `statuses`' own `since`, which resets on every state change even
  // between two unhealthy states (waiting_for_lease -> connecting, say).
  // The watchdog and the bounded log both need the streak's start, or a
  // session that keeps retrying without ever reconnecting would look
  // freshly-unhealthy on every transition and never cross the threshold.
  const unhealthySince = new Map<string, number>();
  const watchdogFired = new Set<string>();
  const lastUnhealthyLogAt = new Map<string, number>();
  let healthCheckInterval: ReturnType<typeof setInterval> | undefined;

  function setStatus(sessionId: string, state: WaConnectionState, lastError?: string): void {
    const prev = statuses.get(sessionId);
    const since = prev && prev.state === state ? prev.since : now();
    const resolvedLastError =
      lastError !== undefined ? lastError : state === "connected" ? undefined : prev?.lastError;
    statuses.set(sessionId, { sessionId, state, since, lastError: resolvedLastError });

    if (state === "connected") {
      unhealthySince.delete(sessionId);
      watchdogFired.delete(sessionId);
      lastUnhealthyLogAt.delete(sessionId);
    } else if (!unhealthySince.has(sessionId)) {
      unhealthySince.set(sessionId, since);
    }
  }

  return {
    name: channelName,
    async start(deps) {
      // `config.logger` wins when set, otherwise fall back to the host's
      // resolved `deps.logger` (the same config-then-server precedence
      // `resolveBrainHooks` applies to the brain hooks) so a
      // `ChatterConfig.logger` reaches this channel's connection/lease
      // lifecycle without every caller having to also pass it into
      // `createWhatsAppChannel` directly.
      const log = config.logger ?? deps.logger ?? createConsoleLogger();
      // `deps.db` is only actually opened when `config.database` was set (see
      // ServerDependencies.db's doc comment) - a host running with
      // `config.retriever` and no `config.database` would otherwise hit this
      // channel's first db call as a bare `undefined.execute` TypeError deep
      // inside the lease-gated retry loop instead of a clear message here.
      // Both stores are only actually required when the caller hasn't
      // injected replacements of their own.
      if ((!config.leaseStore || !config.authStore) && !deps.db) {
        throw new Error(
          "The WhatsApp channel needs a libsql client for auth state and the session lease: " +
            "set config.database (config.retriever alone does not open one), or supply both " +
            "config.leaseStore and config.authStore.",
        );
      }
      const leaseStore = config.leaseStore ?? createTursoWaLeaseStore(deps.db);
      const authStore = config.authStore ?? createTursoWaAuthKV(deps.db);
      senders = deps.senders;
      // Resolve the optional peer dependency eagerly, before returning: a
      // missing package then fails THIS start() call, which `createServer`
      // logs and isolates — instead of resolving successfully and only
      // surfacing the failure later, deep inside a lease-gated retry loop
      // that keeps firing after the server already reported this channel as
      // started.
      await loadBaileys();

      const leaseDeps: LeaseGatedConnectDeps = {
        leaseStore,
        instanceId,
        sessions,
        isStopped: () => stopped,
        connect,
        now,
        staleMs,
        heartbeatMs,
        waitMs,
        schedule,
        logger: log,
        onConnectFailed: recoverFromFailedConnect,
        onStatusChange: setStatus,
      };

      /**
       * The next backoff delay for this session, consuming one failure. Every
       * kind of failed attempt shares this counter - a closed connection, and
       * a connect that threw wherever it was scheduled from - so a database
       * outage that makes connecting throw backs off like any other failure
       * instead of retrying forever at the base delay. Only a connection that
       * opens resets it.
       */
      function nextRetryDelayMs(sessionId: string): number {
        const failures = failureCounts.get(sessionId) ?? 0;
        failureCounts.set(sessionId, failures + 1);
        return reconnectDelayMs(failures);
      }

      /** Run a connect attempt, routing a rejection into the shared recovery. */
      function attemptConnect(sessionId: string): void {
        void connect(sessionId).catch((error) => recoverFromFailedConnect(sessionId, error));
      }

      /**
       * The single recovery path for a connect attempt that threw, wherever
       * it was scheduled from: the first attempt after acquiring the lease, a
       * reconnect after a close, or the unpaired re-check. Baileys registers
       * the reconnect loop on the socket it returns, so an attempt that
       * throws before that leaves no socket and therefore no future "close"
       * event to retry from. Dead-ending here would leave the session holding
       * its lease with nothing connected and nothing scheduled: an instance
       * that looks healthy from the outside and never serves another message.
       * So this releases the session and re-enters the lease-gated retry loop,
       * the same recovery the initial-connect failure path takes.
       */
      function recoverFromFailedConnect(sessionId: string, error: unknown): void {
        // Same guard the close handler applies: a session this instance gave
        // up on purpose must not be revived by a rejection landing later.
        if (stopped) return;
        // Claim it before anything else, so that a heartbeat finding the
        // lease taken over in the same tick recovers this session or this
        // does, never both - two retry chains for one session would both
        // re-acquire under this instance's own id and end up with two sockets
        // on one WhatsApp number.
        const handle = claimSession(sessionId, sessions);
        if (!handle) return;
        const delay = nextRetryDelayMs(sessionId);
        setStatus(sessionId, "disconnected", describeError(error));
        log.error(
          `WhatsApp[${sessionId}]: connect attempt failed, releasing the lease and retrying in ${Math.round(delay / 1000)}s:`,
          error,
        );
        // Scheduled before the teardown rather than chained onto it: the
        // socket here is already dead (this attempt threw, or its predecessor
        // closed), so nothing is on the wire for a reconnect to race, while a
        // release that never settles - a stalled database connection, the very
        // failure being recovered from - would otherwise leave the session
        // with no socket and nothing scheduled all over again.
        schedule(
          () =>
            void acquireSessionLease(sessionId, leaseDeps).catch((retryError) =>
              log.error(`WhatsApp[${sessionId}]: lease re-check failed:`, retryError),
            ),
          delay,
        );
        void shutdownWaSessions(new Map([[sessionId, handle]])).catch((teardownError) =>
          log.warn(
            `WhatsApp[${sessionId}]: teardown after a failed connect failed:`,
            teardownError,
          ),
        );
      }

      async function connect(sessionId: string): Promise<void> {
        // A retry/reconnect timer scheduled before stop() (or before this
        // session lost its lease to another instance) can still fire during
        // teardown — without this guard it would open a brand-new,
        // untracked socket for a session this instance no longer holds the
        // lease for, exactly the concurrent-connection takeover the lease
        // exists to prevent. acquireSessionLease always populates `sessions`
        // before its first connect() call, so this only ever screens out a
        // stale timer.
        if (stopped || !sessions.has(sessionId)) return;
        setStatus(sessionId, "connecting");

        const baileys = await loadBaileys();
        const runtime: AuthStateRuntime = {
          bufferJSON: baileys.BufferJSON,
          initAuthCreds: baileys.initAuthCreds,
          appStateSyncKeyFromObject: (value) =>
            baileys.proto.Message.AppStateSyncKeyData.fromObject(value),
        };
        const { state, saveCreds } = await useAuthState(
          authStore,
          config.sessionSecret,
          sessionId,
          runtime,
        );

        if (!state.creds.registered) {
          log.warn(
            `WhatsApp[${sessionId}]: no paired session found — pair it first (see docs/channels.md). Re-checking in 60s.`,
          );
          setStatus(sessionId, "disconnected", "no paired session - pair it first");
          schedule(() => attemptConnect(sessionId), 60_000);
          return;
        }

        const { version } = await baileys.fetchLatestBaileysVersion();
        const logger = silentLogger();
        const sock = baileys.makeWASocket({
          version,
          auth: {
            creds: state.creds,
            // biome-ignore lint/suspicious/noExplicitAny: silentLogger is structurally pino-compatible; Baileys' logger type is not exported
            keys: baileys.makeCacheableSignalKeyStore(state.keys, logger as any),
          },
          // biome-ignore lint/suspicious/noExplicitAny: silentLogger is structurally pino-compatible; Baileys' logger type is not exported
          logger: logger as any,
          markOnlineOnConnect: false,
          syncFullHistory: false,
        });

        // Wire the shutdown handle to THIS socket immediately, not just once
        // "open" fires — stop() landing mid-handshake (or during any reconnect
        // attempt before the next "open") must still be able to end it.
        const leaseHandle = sessions.get(sessionId);
        if (leaseHandle) leaseHandle.sock = sock;

        // Wrapped: Baileys fires this constantly during key rotation and does
        // not await it — one failed write must log, never crash the process.
        sock.ev.on(
          "creds.update",
          () =>
            void saveCreds().catch((error) =>
              log.warn(`WhatsApp[${sessionId}]: creds save failed:`, error),
            ),
        );

        sock.ev.on("connection.update", (update) => {
          const { connection, lastDisconnect } = update;
          if (connection === "open") {
            failureCounts.set(sessionId, 0);
            setStatus(sessionId, "connected");
            log.info(`WhatsApp[${sessionId}]: connected as ${sock.user?.id ?? "unknown"}`);
            const senderName = senderNameFor(channelName, sessionId);
            const sender: ChannelSender = {
              sendText: async (chatId, text) => {
                await sock.sendMessage(chatId, { text });
              },
              sendMedia: async (chatId, payload) => {
                const { url, caption } = normalizeWaMediaPayload(payload);
                await sock.sendMessage(
                  chatId,
                  caption !== undefined ? { image: { url }, caption } : { image: { url } },
                );
              },
              sendReaction: async (chatId, messageRef, emoji) => {
                await sock.sendMessage(chatId, {
                  react: { text: emoji, key: messageRef as WAMessageKey },
                });
              },
            };
            deps.senders.register(senderName, sender);
            registeredSenderNames.set(sessionId, senderName);
          }
          if (connection === "close") {
            const senderName = registeredSenderNames.get(sessionId);
            if (senderName) {
              deps.senders.unregister(senderName);
              registeredSenderNames.delete(sessionId);
            }
            const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } })
              ?.output?.statusCode;
            if (statusCode === baileys.DisconnectReason.loggedOut) {
              setStatus(sessionId, "disconnected", "session logged out - re-pair required");
              log.error(
                `WhatsApp[${sessionId}]: session logged out — re-pair to reconnect (see docs/channels.md).`,
              );
              // Dead session: stop renewing and free the lease.
              void loseSession(sessionId, sessions);
              return;
            }
            // sessions.has: a close triggered by giving up the session on
            // purpose (loggedOut above, or loseSession ending the socket
            // after a lost heartbeat) must NOT auto-reconnect — that would
            // open a fresh socket for a session this instance no longer
            // holds the lease for.
            if (!stopped && sessions.has(sessionId)) {
              const delay = nextRetryDelayMs(sessionId);
              setStatus(sessionId, "disconnected", `connection closed (${statusCode ?? "?"})`);
              log.warn(
                `WhatsApp[${sessionId}]: connection closed (${statusCode ?? "?"}), reconnecting in ${Math.round(delay / 1000)}s...`,
              );
              // attemptConnect, not a bare catch-and-log: a reconnect that
              // throws has no socket to fire another "close" from, so only
              // the shared recovery keeps the retry chain alive.
              schedule(() => attemptConnect(sessionId), delay);
            }
          }
        });

        if (config.onMessage) {
          sock.ev.on("messages.upsert", async ({ messages, type }) => {
            if (type !== "notify") return;
            for (const message of messages) {
              try {
                await config.onMessage?.({
                  sessionId,
                  sock,
                  message,
                  endpointId: multiEndpoint ? sessionId : undefined,
                });
              } catch (error) {
                log.warn(`WhatsApp[${sessionId}]: onMessage handler failed:`, error);
              }
            }
          });
        }
      }

      /**
       * Runs on the same cadence as the lease heartbeat, independent of
       * whether any session currently holds its lease - `waiting_for_lease`
       * has to be observable too, not just a dead socket. `config.watchdog`
       * fires its callback once per unhealthy streak; when no `onUnhealthy`
       * is configured this instead keeps a bounded error log going, so an
       * unconfigured host still gets a grep-able signal instead of silence.
       */
      function checkHealth(): void {
        const nowMs = now();
        for (const sessionId of sessionIds) {
          const unhealthySinceMs = unhealthySince.get(sessionId);
          if (unhealthySinceMs === undefined) continue;
          const status = statuses.get(sessionId);
          if (!status) continue;

          const watchdog = config.watchdog;
          if (
            watchdog &&
            nowMs - unhealthySinceMs >= watchdog.unhealthyAfterMs &&
            !watchdogFired.has(sessionId)
          ) {
            watchdogFired.add(sessionId);
            watchdog.onUnhealthy?.(status);
          }

          if (!watchdog?.onUnhealthy) {
            // Defaults to the streak's own start, not 0/-Infinity: a routine
            // reconnect that clears within one interval should never log at
            // error level at all, only a session that stays down.
            const lastLogged = lastUnhealthyLogAt.get(sessionId) ?? unhealthySinceMs;
            if (nowMs - lastLogged >= UNHEALTHY_LOG_INTERVAL_MS) {
              lastUnhealthyLogAt.set(sessionId, nowMs);
              log.error(
                `WhatsApp[${sessionId}]: unhealthy (${status.state}) since ${new Date(status.since).toISOString()}` +
                  (status.lastError ? ` - ${status.lastError}` : ""),
              );
            }
          }
        }
      }

      healthCheckInterval = setInterval(checkHealth, heartbeatMs);
      if (typeof healthCheckInterval === "object" && "unref" in healthCheckInterval) {
        healthCheckInterval.unref();
      }

      for (const sessionId of sessionIds) {
        void acquireSessionLease(sessionId, leaseDeps).catch((error) =>
          log.error(`WhatsApp[${sessionId}]: failed to start:`, error),
        );
      }
    },
    async stop() {
      stopped = true;
      if (healthCheckInterval) clearInterval(healthCheckInterval);
      // Otherwise getStatus() keeps reporting whatever state a session was
      // in the instant before teardown - "connected" while its socket is
      // being ended - for as long as the process stays up after stop().
      for (const sessionId of sessionIds) setStatus(sessionId, "disconnected", "channel stopped");
      // The "close" handler unregisters its own session's sender once the
      // socket actually closes, but that fires asynchronously — unregister
      // eagerly here too so a caller sending immediately after `stop()`
      // resolves never races a socket that is merely mid-teardown.
      for (const senderName of registeredSenderNames.values()) {
        senders?.unregister(senderName);
      }
      registeredSenderNames.clear();
      await shutdownWaSessions(sessions);
    },
    getStatus(): WaSessionStatus[] {
      return sessionIds.map(
        (id) => statuses.get(id) ?? { sessionId: id, state: "waiting_for_lease", since: now() },
      );
    },
  };
}
