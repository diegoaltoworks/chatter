/**
 * Channel SPI — the seam a transport (WhatsApp, or any future channel)
 * implements to attach to a chatter server. `createServer` starts every
 * configured channel with the same {@link ServerDependencies} route
 * factories and custom routes receive, so a channel can call
 * `prepareChat`/`answerOnce`, share `deps.db`, etc. without knowing how the
 * server was assembled — and `channel.start(deps)` works identically when
 * called directly, outside `createServer`, for standalone use.
 *
 * Published as the `@diegoaltoworks/chatter/channels` subpath alongside the
 * pure decision gates ({@link decideChannelAction} and friends) and the
 * {@link ChannelSenderRegistry}, so a transport package needs one import for
 * the whole channel toolkit. Zero required dependencies beyond the core
 * package itself.
 *
 * @packageDocumentation
 */

import type { ServerDependencies } from "../types";

export interface Channel {
  /** Human-readable name, used in start-failure log lines and as the sender-registry key. */
  name: string;
  /**
   * Called once, after routes are mounted, with the full server dependencies.
   * Awaited if it returns a promise. A rejection/throw is logged and isolated
   * — one channel failing to start never crashes the server or the other
   * configured channels.
   *
   * `createServer` awaits this before the app is handed back and starts
   * serving requests, so `start` should return once the transport is
   * *initiated* (a socket opened, a listener registered) — not once a remote
   * connection or pairing flow completes. An implementation that awaits a
   * slow handshake blocks the whole server from ever starting.
   */
  start(deps: ServerDependencies): void | Promise<void>;
  /**
   * Called by the host's own shutdown path via the disposer `createServer`
   * returns (`app.stopChannels()`, see `ChatterApp` in `./server`) — never
   * automatically on a process signal, since a library installing its own
   * SIGTERM/SIGINT handler and exiting the process would race a host's
   * shutdown logic.
   */
  stop?(): void | Promise<void>;
}

export * from "./gates";
export {
  createInboundPipeline,
  type InboundPipeline,
  type InboundPipelineConfig,
  type InboundPipelineDeps,
  type InboundPipelineOutcome,
  type InboundReplySender,
  type InboundTurn,
} from "./pipeline";
export type { ChannelSender, ChannelSenderRegistry } from "./senders";
export { createSenderRegistry } from "./senders";
