import type { Context } from "hono";

/**
 * Resolves the caller identity IP-keyed rate limiters bucket on.
 *
 * `X-Forwarded-For` is set by the client unless something in front of
 * Chatter (nginx, Cloudflare, a cloud load balancer) overwrites it with the
 * real socket address. Trusting it unconditionally lets an attacker rotate a
 * fake value on every request and bypass per-IP limits entirely. Pass
 * `trustProxy: true` only when such a proxy is guaranteed to be in front —
 * otherwise every caller collapses onto one shared bucket, which is coarse
 * but not bypassable, and pair it with a fronting proxy that does the real
 * per-client limiting.
 */
export function clientRateLimitKey(c: Context, trustProxy: boolean): string {
  if (!trustProxy) return "shared";
  const header = c.req.header("x-forwarded-for");
  if (!header) return "unknown-ip";
  return header.split(",")[0].trim() || "unknown-ip";
}
