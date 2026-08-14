/**
 * Retrieval bucket resolution — which slices of the knowledge base a single
 * chat turn is allowed to see.
 *
 * Knowledge is ingested into named buckets (see ./loaders). By default a chat
 * turn retrieves from `base` plus the bucket matching its mode, which keeps
 * `private` knowledge off public surfaces. Role-gated deployments need more
 * than that: a signed-in operator may be entitled to buckets an anonymous
 * visitor is not, and the entitlement is only knowable per request.
 *
 * `bucketsFor` is that seam. Surfaces (routes, channels) call
 * {@link resolveBuckets} with whatever sender identity they hold and pass the
 * result to `prepareChat`. The security invariant lives here, in one pure
 * function, rather than being re-derived by every surface:
 *
 *   **The hook can only widen retrieval for a caller the surface could name.**
 *   Without a sender identity, its answer is clamped to the buckets the mode
 *   would have retrieved anyway — so a hook asking for `private` from a public
 *   surface gets it dropped, not honoured.
 *
 * Anonymous surfaces run the public pipeline, so their ceiling is the public
 * defaults and private knowledge stays out of reach. Clamping to the mode
 * defaults rather than always to the public ones keeps the two ways a hook can
 * decline to widen — returning the defaults, or returning `undefined` —
 * behaving identically; a ceiling that depended on which one a hook picked
 * would be a trap rather than a guarantee.
 *
 * Narrowing is always allowed — a hook may hand back fewer buckets, or none
 * at all, on any surface.
 */

import type { PipelineMode } from "./pipeline";

/** Buckets a mode retrieves from when nothing overrides it. */
export function defaultBuckets(mode: PipelineMode): string[] {
  return ["base", mode];
}

/** What a surface knows about the caller when it asks for buckets. */
export interface BucketsForContext {
  /** The pipeline the turn is running through */
  mode: PipelineMode;
  /**
   * Stable identifier for the caller (JWT subject, channel sender id, ...).
   * Absent on anonymous surfaces — see the clamp in {@link resolveBuckets}.
   */
  sender?: string;
}

/**
 * Per-request retrieval bucket policy.
 *
 * Return the buckets this caller may retrieve from, or `undefined` to leave
 * the mode defaults in place. May be async — role lookups usually are.
 */
export type BucketsFor = (
  ctx: BucketsForContext,
) => string[] | undefined | Promise<string[] | undefined>;

/** A sender identity is only an identity if it is a non-blank string. */
function isIdentified(sender: string | undefined): sender is string {
  return typeof sender === "string" && sender.trim().length > 0;
}

/**
 * Trim, drop blanks, de-duplicate. Non-strings are dropped rather than
 * coerced: the list crosses a plugin boundary, and a stringified `null` is a
 * bucket name nobody meant to ask for.
 */
function normalize(buckets: unknown[]): string[] {
  const out: string[] = [];
  for (const raw of buckets) {
    if (typeof raw !== "string") continue;
    const bucket = raw.trim();
    if (bucket && !out.includes(bucket)) out.push(bucket);
  }
  return out;
}

/**
 * Ask the configured `bucketsFor` hook which buckets this turn may retrieve
 * from, and enforce the anonymous ceiling on its answer.
 *
 * Returns `undefined` when the caller should keep the mode defaults: no hook
 * configured, or a hook that returned `undefined`. An explicitly empty array
 * is honoured as "retrieve nothing" and is never silently widened back to the
 * defaults — that fallback would hand a private-mode caller the `private`
 * bucket precisely when the hook had refused it.
 *
 * Without a sender the answer is filtered down to `defaultBuckets(mode)`, so
 * an unidentified caller can never end up with more than the surface would
 * have retrieved on its own. Pass the sender to unlock the extra buckets an
 * identified caller is entitled to.
 *
 * A rejected hook propagates: retrieval scope is a security decision, and a
 * policy lookup that failed must not silently fall back to the defaults.
 */
export async function resolveBuckets({
  mode,
  sender,
  bucketsFor,
}: {
  mode: PipelineMode;
  sender?: string;
  bucketsFor?: BucketsFor;
}): Promise<string[] | undefined> {
  if (!bucketsFor) return undefined;

  const identified = isIdentified(sender);
  const requested = await bucketsFor(identified ? { mode, sender } : { mode });
  if (!Array.isArray(requested)) return undefined;

  const cleaned = normalize(requested);
  if (identified) return cleaned;

  const ceiling = new Set(defaultBuckets(mode));
  return cleaned.filter((bucket) => ceiling.has(bucket));
}
