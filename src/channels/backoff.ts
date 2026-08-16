/**
 * Exponential backoff with a cap: `base * 2^n`, `n` clamped to `[0, 20]` so
 * the exponent never overflows long before `max` would bind anyway. Every
 * poll/sync/reconnect loop in `src/channels/` computes its retry delay this
 * way (`./telegram/poll.ts`, `./matrix/sync.ts`, `./whatsapp/channel.ts`,
 * `./whatsapp/pairing.ts`); only `base`, `max`, and what `n` counts
 * (failures seen vs. attempts made) differ between them.
 */
export function exponentialBackoffMs(baseMs: number, maxMs: number, n: number): number {
  return Math.min(baseMs * 2 ** Math.max(0, Math.min(n, 20)), maxMs);
}
