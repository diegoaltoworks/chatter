/**
 * WhatsApp web-client transport — a {@link Channel} built on Baileys
 * (`@whiskeysockets/baileys`, an OPTIONAL peer dependency; nothing in core or
 * `./channels` imports it, so `bun install` and every core import work
 * without it).
 *
 * ```ts
 * import { createWhatsAppChannel } from "@diegoaltoworks/chatter/whatsapp";
 *
 * const channel = createWhatsAppChannel({
 *   sessionSecret: process.env.WA_SESSION_SECRET as string,
 *   sessionIds: (process.env.WA_SESSION_IDS ?? "default").split(","),
 *   onMessage: async ({ sessionId, sock, message }) => {
 *     // apply ./channels' decideChannelAction, resolve the reply, sock.sendMessage(...)
 *   },
 * });
 *
 * await createServer({ ..., channels: [channel] });
 * ```
 *
 * ToS note: Baileys is an unofficial WhatsApp client. A linked number can be
 * banned — use one you can afford to lose, and keep this channel opt-in.
 *
 * @packageDocumentation
 */

export type { AuthStateRuntime, TursoAuthStateResult } from "./authState";
export { useTursoAuthState } from "./authState";
export type { Baileys } from "./baileys";
export { loadBaileys } from "./baileys";
export {
  acquireSessionLease,
  createWhatsAppChannel,
  type LeaseGatedConnectDeps,
  reconnectDelayMs,
  senderNameFor,
  shutdownWaSessions,
  type WaSessionHandle,
  type WhatsAppChannelConfig,
  type WhatsAppMessageEvent,
} from "./channel";
export { decrypt, encrypt } from "./crypto";
export {
  canAcquireLease,
  createTursoWaLeaseStore,
  LEASE_HEARTBEAT_MS,
  LEASE_STALE_MS,
  LEASE_WAIT_MS,
  type WaLeaseRow,
  type WaLeaseStore,
} from "./lease";
