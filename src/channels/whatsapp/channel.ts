/**
 * WhatsApp web-client transport: a {@link Channel} that runs one Baileys
 * socket per configured session id (one WhatsApp number each), auth state
 * encrypted in the host's own database (`deps.db` — no second connection
 * opened), and a deploy lease so two overlapping instances can never hold the
 * same session's socket at once (WhatsApp treats a second connection as a
 * takeover and logs the first one out).
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

import type { Client } from "@libsql/client";
import type { WAMessage, WAMessageKey, WASocket } from "@whiskeysockets/baileys";
import { assertStrongSecret } from "../../auth/secretStrength";
import { createConsoleLogger, type Logger } from "../../core/logger";
import type { Channel } from "../index";
import type { ChannelSender } from "../senders";
import type { AuthStateRuntime } from "./authState";
import { useTursoAuthState } from "./authState";
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

/** Exponential backoff: 5s, 10s, 20s ... capped at 10 minutes. Hammering
 * WhatsApp every few seconds during an outage or ban aggravates ban scoring. */
export function reconnectDelayMs(failures: number): number {
  return Math.min(RECONNECT_DELAY_MS * 2 ** Math.min(failures, 20), RECONNECT_MAX_DELAY_MS);
}

export interface WhatsAppMessageEvent {
  sessionId: string;
  sock: WASocket;
  message: WAMessage;
}

export interface WhatsAppChannelConfig {
  /** Passphrase that encrypts auth state at rest (AES-256-GCM key material). Keep it stable across restarts and deploys — losing it means re-pairing. */
  sessionSecret: string;
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

async function loseSession(
  sessionId: string,
  sessions: Map<string, WaSessionHandle>,
): Promise<void> {
  const handle = sessions.get(sessionId);
  if (!handle) return;
  sessions.delete(sessionId);
  await shutdownWaSessions(new Map([[sessionId, handle]]));
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
}

/**
 * Acquire `sessionId`'s lease before connecting — two instances must never
 * run concurrent Baileys clients for the same session. Not holding it (or a
 * database blip while trying) means wait and re-check instead of connecting.
 * Once held, a heartbeat renews it for as long as the session runs; if a
 * heartbeat ever finds the lease gone (this instance went stale and another
 * took over), the session is torn down and this re-enters the same
 * wait-and-retry loop rather than staying connected alongside the new holder.
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
    retry();
    return;
  }
  if (!acquired) {
    logger.warn(`WhatsApp[${sessionId}]: lease held by another instance, re-checking later`);
    retry();
    return;
  }

  const heartbeat = setInterval(() => {
    void leaseStore
      .tryAcquire(sessionId, instanceId, now(), staleMs)
      .then((stillHeld) => {
        if (stillHeld || isStopped()) return;
        logger.error(`WhatsApp[${sessionId}]: lost the lease to another instance — disconnecting`);
        void loseSession(sessionId, sessions).then(retry);
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
    logger.error(`WhatsApp[${sessionId}]: connect failed right after acquiring the lease:`, error);
    await loseSession(sessionId, sessions);
    retry();
  }
}

/** Sender-registry name for a session — the default session stays unprefixed so single-number deployments see a plain `"whatsapp"` name. */
export function senderNameFor(channelName: string, sessionId: string): string {
  return sessionId === "default" ? channelName : `${channelName}:${sessionId}`;
}

export function createWhatsAppChannel(config: WhatsAppChannelConfig): Channel {
  assertStrongSecret(config.sessionSecret, "WhatsApp sessionSecret (e.g. WA_SESSION_SECRET)");
  const channelName = "whatsapp";
  const sessionIds =
    config.sessionIds && config.sessionIds.length > 0 ? config.sessionIds : ["default"];
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

  return {
    name: channelName,
    async start(deps) {
      // `config.logger` wins when set — otherwise fall back to the host's
      // resolved `deps.logger` (same precedence as `config.answerFn ??
      // deps.config.answerFn` elsewhere) so a `ChatterConfig.logger` reaches
      // this channel's connection/lease lifecycle without every caller
      // having to also pass it into `createWhatsAppChannel` directly.
      const log = config.logger ?? deps.logger ?? createConsoleLogger();
      const db: Client = deps.db;
      const leaseStore = createTursoWaLeaseStore(db);
      senders = deps.senders;
      // Resolve the optional peer dependency eagerly, before returning: a
      // missing package then fails THIS start() call, which `createServer`
      // (and any standalone caller) logs and isolates — instead of
      // resolving successfully and only surfacing the failure later, deep
      // inside a lease-gated retry loop that keeps firing after the server
      // already reported this channel as started.
      await loadBaileys();

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

        const baileys = await loadBaileys();
        const runtime: AuthStateRuntime = {
          bufferJSON: baileys.BufferJSON,
          initAuthCreds: baileys.initAuthCreds,
          appStateSyncKeyFromObject: (value) =>
            baileys.proto.Message.AppStateSyncKeyData.fromObject(value),
        };
        const { state, saveCreds } = await useTursoAuthState(
          db,
          config.sessionSecret,
          sessionId,
          runtime,
        );

        if (!state.creds.registered) {
          log.warn(
            `WhatsApp[${sessionId}]: no paired session found — pair it first (see docs/channels.md). Re-checking in 60s.`,
          );
          schedule(() => void connect(sessionId).catch(() => undefined), 60_000);
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
            log.info(`WhatsApp[${sessionId}]: connected as ${sock.user?.id ?? "unknown"}`);
            const senderName = senderNameFor(channelName, sessionId);
            const sender: ChannelSender = {
              sendText: async (chatId, text) => {
                await sock.sendMessage(chatId, { text });
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
              const delay = reconnectDelayMs(failureCounts.get(sessionId) ?? 0);
              failureCounts.set(sessionId, (failureCounts.get(sessionId) ?? 0) + 1);
              log.warn(
                `WhatsApp[${sessionId}]: connection closed (${statusCode ?? "?"}), reconnecting in ${Math.round(delay / 1000)}s...`,
              );
              schedule(
                () =>
                  void connect(sessionId).catch((error) =>
                    log.error(`WhatsApp[${sessionId}]: reconnect failed:`, error),
                  ),
                delay,
              );
            }
          }
        });

        if (config.onMessage) {
          sock.ev.on("messages.upsert", async ({ messages, type }) => {
            if (type !== "notify") return;
            for (const message of messages) {
              try {
                await config.onMessage?.({ sessionId, sock, message });
              } catch (error) {
                log.warn(`WhatsApp[${sessionId}]: onMessage handler failed:`, error);
              }
            }
          });
        }
      }

      for (const sessionId of sessionIds) {
        void acquireSessionLease(sessionId, {
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
        }).catch((error) => log.error(`WhatsApp[${sessionId}]: failed to start:`, error));
      }
    },
    async stop() {
      stopped = true;
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
  };
}
