/**
 * Compose N transport-specific message detectors behind ONE gate
 * resolution per inbound WhatsApp message.
 *
 * A host running its own interceptors alongside the normal chat reply —
 * a voice-note trigger, a fixed-content reaction, an LLM-extraction reply
 * that replaces the answer — has historically had to re-derive the same
 * boilerplate per interceptor: resolving own-identity jids off the socket,
 * the cross-session loop guard, and the allowlist wiring `decideChannelAction`
 * already owns. Copy-pasted across interceptors, that boilerplate drifts, and
 * nothing stops a handler meant to run *alongside* the real reply
 * (`mode: "parallel"`) from being wired with the *replaces the reply*
 * convention (`mode: "replace"`) instead — silently eating the real answer.
 *
 * `createWhatsAppMessageRouter` resolves identity/gating once via
 * `resolveWaMessage` (the same helper `createWhatsAppInboundHandler` uses),
 * builds one {@link WaDetectorContext} for every detector, then:
 *
 * - fires every matching `"parallel"` detector without awaiting or gating
 *   the reply path — a rejection is caught and logged, never surfaces as an
 *   unhandled rejection, and never blocks another detector or the fallback.
 * - walks `"replace"` detectors in registration order and stops at the
 *   first whose `test` matches, awaiting its `handle` and skipping the
 *   fallback entirely; no match runs `fallback` instead.
 *
 * The two modes are distinct at the type level (see {@link MessageDetector}):
 * both `handle` signatures return `Promise<void>`, so there is no
 * boolean-return convention to confuse between them — reaching `handle` at
 * all already means "this detector claims the message" for a `"replace"`
 * detector, or "fire independently" for a `"parallel"` one.
 *
 * `fallback` is deliberately typed the same as `onMessage`/`createWhatsAppInboundHandler`'s
 * return, so an existing single-handler host becomes the router's fallback
 * with zero adaptation — see docs/channels.md. Note that plugging it in this
 * way means `resolveWaMessage` runs a second time inside it (once here for
 * every detector, once more inside the fallback it delegates to) — cheap and
 * side-effect-idempotent (it re-derives the same values and re-writes the
 * same registry entry), but real. "Once per message" below is a guarantee
 * for the detectors, not for whatever the fallback does internally.
 */

import type { WAMessage, WASocket } from "@whiskeysockets/baileys";
import {
  type ChannelAction,
  type ChannelMessage,
  decideChannelAction,
  type SessionIdentityRegistry,
} from "../gates";
import type { WhatsAppMessageEvent } from "./channel";
import { resolveWaMessage } from "./inbound";

/** Everything a detector needs, already resolved — never a raw Baileys shape to re-derive. */
export interface WaDetectorContext {
  event: WhatsAppMessageEvent;
  sock: WASocket;
  message: WAMessage;
  msg: ChannelMessage;
  /** This session's own identities (phone + LID, normalized). */
  ownIds: string[];
  senderId: string;
  /** The already-extracted, own-mention-stripped text — see `stripOwnMentions`. */
  text: string;
  /**
   * What `decideChannelAction` would do with this message given THIS
   * router's own `allowedChats`/`mutedChats`/`muteRegex`/`unmuteRegex` —
   * informational; detectors decide independently via their own `test`.
   * If `fallback` is `createWhatsAppInboundHandler`, note it keeps its own
   * private mute set — this `action` will not reflect chats muted there
   * unless the same mute inputs are also configured on the router.
   */
  action: ChannelAction;
}

interface DetectorBase {
  /** Used only in warning logs when a detector throws. */
  name: string;
  test: (ctx: WaDetectorContext) => boolean | Promise<boolean>;
}

/** Fires independently of every other detector and of the fallback — never stops the reply path, never treated as "handled". */
export interface ParallelDetector extends DetectorBase {
  mode: "parallel";
  handle: (ctx: WaDetectorContext) => Promise<void>;
}

/** The first matching `"replace"` detector (in registration order) fully owns the message — its `handle` runs and the fallback is skipped. */
export interface ReplaceDetector extends DetectorBase {
  mode: "replace";
  handle: (ctx: WaDetectorContext) => Promise<void>;
}

export type MessageDetector = ParallelDetector | ReplaceDetector;

export interface WhatsAppMessageRouterConfig {
  /** Shared across every session and every consumer resolving identity from it — see `resolveWaMessage`. */
  registry: SessionIdentityRegistry;
  /** Same meaning as `WhatsAppInboundConfig.allowedChats`: group chats eligible for routing. Empty (default) = every group; has no effect on DMs. Enforced for every detector and the fallback, independently of message text (a caption-less photo/voice note in a non-allowlisted group is dropped too). */
  allowedChats?: string[];
  /** Only consulted to compute `WaDetectorContext.action`; the router itself doesn't act on mute state. */
  mutedChats?: Set<string>;
  muteRegex?: RegExp;
  unmuteRegex?: RegExp;
  /** Checked in the given order for `"replace"`, independently for `"parallel"`. */
  detectors: MessageDetector[];
  /**
   * Runs when no `"replace"` detector matches. Typed identically to
   * `onMessage`/`createWhatsAppInboundHandler`'s return, so an existing
   * single-handler host plugs in unchanged.
   */
  fallback: (event: WhatsAppMessageEvent) => Promise<void>;
  /** A throwing/rejecting callback here is itself caught and logged with `console.warn` — it can never produce an unhandled rejection. */
  onDetectorError?: (detectorName: string, error: unknown) => void;
}

async function logDetectorError(
  config: WhatsAppMessageRouterConfig,
  name: string,
  error: unknown,
): Promise<void> {
  if (!config.onDetectorError) {
    console.warn(`WhatsApp router: detector "${name}" failed:`, error);
    return;
  }
  try {
    await config.onDetectorError(name, error);
  } catch (callbackError) {
    console.warn(`WhatsApp router: onDetectorError itself failed:`, callbackError);
  }
}

/**
 * True when `msg`'s chat is ineligible for `allowedChats` — group-only,
 * text-blind (unlike `isBlockedByAllowlist` in `../gates`, which requires
 * non-empty text because it exists to attribute *reply* drops; a
 * caption-less photo or voice note must be dropped here just the same, since
 * every detector — not only the reply path — is gated on chat eligibility).
 */
function isChatIneligible(msg: ChannelMessage, allowedChats: string[]): boolean {
  return !msg.isDirectMessage && allowedChats.length > 0 && !allowedChats.includes(msg.chatId);
}

/** Fire-and-forget: internal errors are caught and logged so a `"parallel"` detector can never produce an unhandled rejection or block anything else. */
function fireParallelDetector(
  config: WhatsAppMessageRouterConfig,
  detector: ParallelDetector,
  ctx: WaDetectorContext,
): void {
  void (async () => {
    try {
      if (await detector.test(ctx)) {
        await detector.handle(ctx);
      }
    } catch (error) {
      await logDetectorError(config, detector.name, error);
    }
  })();
}

/** Builds the `onMessage` handler for `createWhatsAppChannel` that fans a raw message out to N detectors — see the module docstring. */
export function createWhatsAppMessageRouter(
  config: WhatsAppMessageRouterConfig,
): (event: WhatsAppMessageEvent) => Promise<void> {
  const allowedChats = config.allowedChats ?? [];
  const mutedChats = config.mutedChats ?? new Set<string>();
  const replaceDetectors = config.detectors.filter(
    (d): d is ReplaceDetector => d.mode === "replace",
  );
  const parallelDetectors = config.detectors.filter(
    (d): d is ParallelDetector => d.mode === "parallel",
  );

  return async function routeWhatsAppMessage(event: WhatsAppMessageEvent): Promise<void> {
    const { sock, message } = event;

    let ctx: WaDetectorContext;
    try {
      const chatId = message.key.remoteJid ?? "";
      if (!chatId || chatId === "status@broadcast") return;

      const { msg, ownIds } = resolveWaMessage(event, config.registry);

      // The loop guard and the master allowlist switch are hard invariants
      // for every detector and the fallback alike — a detector reacting to
      // the bot's own traffic or to a chat the whole channel isn't eligible
      // for would defeat exactly what those checks exist for.
      if (msg.fromBot || isChatIneligible(msg, allowedChats)) return;

      const action = decideChannelAction(msg, {
        allowedChats,
        mutedChats,
        muteRegex: config.muteRegex,
        unmuteRegex: config.unmuteRegex,
      });

      ctx = {
        event,
        sock,
        message,
        msg,
        ownIds,
        senderId: msg.senderId,
        text: msg.text,
        action,
      };
    } catch (error) {
      await logDetectorError(config, "resolve", error);
      return;
    }

    for (const detector of parallelDetectors) {
      fireParallelDetector(config, detector, ctx);
    }

    for (const detector of replaceDetectors) {
      let matched: boolean;
      try {
        matched = await detector.test(ctx);
      } catch (error) {
        await logDetectorError(config, detector.name, error);
        continue;
      }
      if (!matched) continue;
      try {
        await detector.handle(ctx);
      } catch (error) {
        await logDetectorError(config, detector.name, error);
      }
      return;
    }

    try {
      await config.fallback(event);
    } catch (error) {
      await logDetectorError(config, "fallback", error);
    }
  };
}
