/**
 * The one place `./whatsapp` touches the `@whiskeysockets/baileys` package at
 * runtime. It's an OPTIONAL peer dependency — `bun install` and every core
 * import must work without it — so nothing in this subpath may `import` it
 * statically; every other module here takes what it needs as a value (see
 * `AuthStateRuntime` in `authState.ts`) or a type-only import (erased at
 * compile time, so it costs nothing at runtime).
 *
 * `loadBaileys()` is the single dynamic import, called lazily when a channel
 * actually starts, so a missing package fails with an actionable message
 * instead of a raw "Cannot find module" — or, worse, at unrelated core
 * imports that never touch WhatsApp at all.
 */

import type * as BaileysModule from "@whiskeysockets/baileys";

export type Baileys = typeof BaileysModule;

/** Wraps a failed `import("@whiskeysockets/baileys")` in an actionable message. Exported separately so the message content is unit-testable without simulating a real missing module. */
export function wrapMissingBaileysError(cause: unknown): Error {
  return new Error(
    "The WhatsApp channel ('@diegoaltoworks/chatter/whatsapp') requires the optional " +
      "peer dependency '@whiskeysockets/baileys', which is not installed. Install it with " +
      "`bun add @whiskeysockets/baileys` (or npm/pnpm/yarn) to use this channel.",
    { cause },
  );
}

let cached: Promise<Baileys> | undefined;

export function loadBaileys(): Promise<Baileys> {
  if (!cached) {
    cached = import("@whiskeysockets/baileys").catch((error) => {
      cached = undefined;
      throw wrapMissingBaileysError(error);
    }) as Promise<Baileys>;
  }
  return cached;
}

/** A silent, structurally pino-compatible logger — Baileys logs very verbosely by default. */
export function silentLogger(): unknown {
  const noop = () => undefined;
  const logger: Record<string, unknown> = {
    level: "silent",
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
  };
  logger.child = () => logger;
  return logger;
}
