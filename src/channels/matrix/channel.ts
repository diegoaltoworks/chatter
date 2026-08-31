/**
 * Matrix client-server transport: a {@link Channel} that long-polls
 * `/sync`, maps each room event into a `ChannelMessage`, and answers
 * through the shared `createInboundPipeline` — the same gates, persona,
 * buckets, history and `answerFn` seams every other channel uses.
 *
 * Deliberately the plain client-server HTTP API over `fetch`, not an SDK:
 * no optional peer dependency, same as `../telegram`. That also means
 * **no end-to-end encryption support** — an encrypted room's events arrive
 * as opaque `m.room.encrypted` ciphertext this channel cannot decrypt, so
 * it silently cannot see anything sent there. Use this channel only in
 * unencrypted rooms; see docs/matrix.md for the full explanation and why
 * that rules out most default-E2EE personal homeservers for DMs.
 */

import { createConsoleLogger } from "../../core/logger";
import type { Channel } from "../index";
import { createInboundPipeline, resolveBrainHooks } from "../pipeline";
import { defaultSleep, type PollingChannelConfig } from "../polling";
import { createMatrixApi, type MatrixApi } from "./api";
import { createMatrixSender, createMatrixSyncHandler } from "./handler";
import { runMatrixSyncLoop } from "./sync";
import { type MatrixDirectMapping, matrixOwnIdentities, toDirectMapping } from "./updates";

/** Long-poll hold time. The homeserver holds the request open this long when nothing new happened, so a sync is one request per 30s idle — not a busy loop. */
const DEFAULT_SYNC_TIMEOUT_MS = 30_000;

export interface MatrixChannelConfig extends PollingChannelConfig {
  /** Homeserver client-server API origin, e.g. `https://matrix.example.org`. */
  homeserverUrl: string;
  /** A logged-in bot user's access token. A credential — pass it from the environment, never commit it. */
  accessToken: string;
  /** Channel and sender-registry name. Override to run more than one bot in one process. @default "matrix" */
  name?: string;
  /** Extra system-prompt section describing the delivery channel; passed through to `prepareChat`. @default "Channel: Matrix." */
  channelHint?: string;
  /** A throw/rejection is treated as "no persona" for that turn. `sender` is the namespaced `mx:<user id>` key. */
  personaResolver?: (ctx: {
    sender: string;
    text: string;
    /** Which of this process's endpoints received the message - see `ChannelMessage.endpointId`. Unset unless the channel runs more than one. */
    endpointId?: string;
  }) => string | undefined | Promise<string | undefined>;
  /** Auto-accept room invites, so the bot can actually receive messages in a room a user just invited it to. @default true */
  autoJoin?: boolean;
  /** @default 30000 */
  syncTimeoutMs?: number;
  /** Resume point for `/sync`. Omitted = an initial full sync (see docs/matrix.md on `since`-token persistence). */
  initialSince?: string;
  /** Called with each acknowledged `since` token, for a host that wants to persist it across restarts. */
  onSince?: (since: string) => void;
  /** Cap on the bytes a `sendMedia` https URL may pull before upload. @default 25 MiB */
  maxMediaBytes?: number;
  /** Overridable for tests, which fake the client-server API instead of calling it; defaults to a `fetch` client over {@link MatrixChannelConfig.homeserverUrl}/{@link MatrixChannelConfig.accessToken}. */
  api?: MatrixApi;
}

export function createMatrixChannel(config: MatrixChannelConfig): Channel {
  const channelName = config.name ?? "matrix";
  const allowedChats = config.allowedChats ?? [];
  const sleep = config.sleep ?? defaultSleep;
  const syncTimeoutMs = config.syncTimeoutMs ?? DEFAULT_SYNC_TIMEOUT_MS;

  let stopped = false;
  let registered = false;
  // Cuts the in-flight `/sync` on stop(): without it, teardown would block
  // for up to `syncTimeoutMs` waiting for a long poll whose result is
  // already unwanted.
  let abort: AbortController | undefined;
  let senders: { unregister(name: string): void } | undefined;
  // This session's own sent event ids — shared between the sync handler
  // (reply-to-bot detection) and the registered sender (a scheduler/flow
  // reply outside a pipeline turn is still recognised later).
  const sentEventIds = new Set<string>();

  return {
    name: channelName,
    async start(deps) {
      const log = config.logger ?? deps.logger ?? createConsoleLogger();
      const api =
        config.api ??
        createMatrixApi({
          homeserverUrl: config.homeserverUrl,
          accessToken: config.accessToken,
          fetch: config.fetch,
          maxMediaBytes: config.maxMediaBytes,
        });

      // Resolved eagerly, before returning: the bot's own user id is what
      // mention, loop-guard and reply-to detection compare against, so a
      // channel that synced without it would misfire on all three. A bad
      // token fails THIS start() call, which `createServer` logs and
      // isolates, instead of failing silently later inside the sync loop.
      const me = await api.whoami();
      const label = `Matrix[${me.userId}]`;

      // Registered before the first sync, so this channel's very first
      // inbound resolves against a complete view of the server's identities.
      // Never removed - see SessionIdentityRegistry.
      const identities = config.identities ?? deps.identities;
      identities.set(channelName, matrixOwnIdentities(me));

      // Seeds direct-message detection from the account state as it stands
      // right now, rather than waiting for `m.direct` to show up in a future
      // `/sync` response — an incremental sync (resuming from
      // `initialSince`) only repeats an account-data event when it actually
      // changes, so without this every already-known DM would need a fresh
      // `m.direct` write before this process would recognise it again. What
      // makes this mapping non-empty in the first place is the handler's own
      // write when it accepts an `is_direct` invite (see `./handler`).
      // Best-effort: a fetch failure just means DM detection starts from the
      // invites this session sees, not a broken start().
      let initialDirect: MatrixDirectMapping | undefined;
      try {
        const direct = await api.getAccountData<Record<string, unknown>>(me.userId, "m.direct");
        if (direct) initialDirect = toDirectMapping(direct);
      } catch (error) {
        log.warn(`${label}: could not load m.direct account data at start:`, error);
      }

      deps.senders.register(channelName, createMatrixSender(api, sentEventIds));
      senders = deps.senders;
      registered = true;

      // Built once per start, not per batch: gates, mute state and rate
      // limiters live in this closure.
      const pipeline = createInboundPipeline(
        { client: deps.client, store: deps.store, prompts: deps.prompts },
        {
          channel: channelName,
          ...resolveBrainHooks(config, deps.config),
          model: config.model,
          channelHint: config.channelHint ?? "Channel: Matrix.",
          personaResolver: config.personaResolver,
          history: config.history,
          allowedChats,
          muteRegex: config.muteRegex,
          unmuteRegex: config.unmuteRegex,
          muteReply: config.muteReply,
          unmuteReply: config.unmuteReply,
          dmRateLimit: config.dmRateLimit,
          groupRateLimit: config.groupRateLimit,
          now: config.now,
          logger: log,
        },
      );

      const handleSync = createMatrixSyncHandler({
        api,
        me,
        identities,
        pipeline,
        allowedChats,
        sentEventIds,
        autoJoin: config.autoJoin,
        initialDirect,
        logger: log,
        label,
        // config.name, not the resolved channelName: endpointId opts in only
        // when the host explicitly named this channel (running more than
        // one bot in the process), not for a default single-token channel.
        channelName: config.name,
      });

      abort = new AbortController();
      const signal = abort.signal;

      // Not awaited: `start` must return once the transport is initiated,
      // not once syncing ends (which is at shutdown). `stop()` flips
      // `stopped` and aborts `signal`, so an idle `/sync` already parked on
      // the homeserver for up to `syncTimeoutMs` is cut immediately instead
      // of holding shutdown open until it times out on its own.
      void runMatrixSyncLoop({
        sync: (since) => api.sync({ since, timeoutMs: syncTimeoutMs, signal }),
        handleSync,
        isStopped: () => stopped,
        sleep,
        initialSince: config.initialSince,
        onSince: config.onSince,
        logger: log,
        label,
      }).catch((error) => log.error(`${label}: sync loop ended unexpectedly:`, error));

      log.info(`${label}: syncing for events`);
    },
    stop() {
      stopped = true;
      abort?.abort();
      if (registered) {
        senders?.unregister(channelName);
        registered = false;
      }
    },
  };
}
