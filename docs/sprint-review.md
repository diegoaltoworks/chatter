# Cross-module review: brain + sockets (v0.40)

A read-mostly audit of the "brain + sockets" body of work (pipeline hooks,
the shared db handle, async `customRoutes`, the channel SPI, the WhatsApp
channel, `./personas`, `./flows`, `./images`, `./usage`, the scheduler, the
shortener, and the proveout example), as of the release this audit shipped
in. Scope: confirm cross-module paths and security invariants are actually
exercised end to end, not just covered by per-module unit tests, and file any
gaps found. This is a point-in-time snapshot - re-audit rather than trust it
once the modules it names have moved on.

## Cross-module paths reviewed

- **Gates -> channel -> pipeline.** A gated "ignore" decision leaves `answerFn`
  uncalled and never sends a reply - covered end to end in the WhatsApp
  inbound handler's tests, not just in isolation on `decideChannelAction`.
- **Personas -> prepareChat.** Previously only a fake resolver callback or a
  literal string exercised the `personaLayer` seam. Added a test chaining a
  real `createPersonaResolver` through the WhatsApp inbound handler into
  `prepareChat`'s assembled system prompt, and a second, narrower test doing
  the same directly against `prepareChat` (see below).
- **Usage reserve semantics.** Ordering (per-key before global) and
  reserve-once are directly and thoroughly unit tested. The limiter is
  currently wired into production code only through the WhatsApp image
  handler - no core HTTP route calls it yet, which is expected since nothing
  so far requires it there.
- **Flows contract.** A fixture-based test loads real flow directories
  (`flow.json` + `handler.ts` + `instructions.md`) through the full
  loader -> registry -> intent -> params -> manager chain, including a
  Turso-backed session store round trip. Adequate.
- **Auth-state lease.** A real Turso-backed lease store is exercised under
  concurrent acquisition, and a separate test proves the live heartbeat loop
  tears a session down once superseded. Adequate.
- **Pairing 515 path.** The registered-persist acceptance criteria (515 ->
  reconnect -> late `creds.update` -> verified `registered: true` before
  success is printed) are directly modeled with a faked socket and a faked
  in-memory session store that mimics the shape `useTursoAuthState` hands
  the CLI. Adequate for the sequencing logic; the real Turso store's own
  persistence is covered separately by `authState.test.ts`.

## Security invariants reviewed

- **Anonymous surfaces cannot reach private RAG buckets.** A route-level test
  proves a public-mode request asking to widen its buckets to include
  `private` is clamped before retrieval, not just the bucket-resolution
  helper in isolation. Adequate.
- **Client-supplied `model` is ignored.** The OpenAI-compatible route ignores
  a client-supplied `model` field and always dispatches with the configured
  one; the public/private routes never read a `model` field from the request
  body at all. Adequate.
- **WhatsApp auth state is encrypted at rest.** Existing tests proved
  encrypt/decrypt round trips and rejected the wrong secret, but nothing read
  the raw stored row back to confirm it never contains the plaintext session
  JSON, and nothing ruled out a weak, non-cryptographic encoding passing the
  same substring checks. Added (see below).
- **Spend caps enforced before paid calls.** A cache hit is proven, across
  two tests at two layers, to skip both the usage reservation and the
  underlying OpenAI/Cloudinary calls; a blocked reservation is proven to
  never reach image generation. Adequate.

## Gaps found and closed

Three tests were added to close genuine end-to-end coverage gaps (no code
defects were found - the underlying behavior was already correct, it just
wasn't asserted at the cross-module boundary):

- `src/channels/whatsapp/inbound.test.ts`: a real `createPersonaResolver`
  loading a prompt file from disk is wired as the inbound handler's
  `personaResolver`, and its output is asserted in the system prompt
  `answerFn` receives.
- `src/personas/resolver.test.ts`: the same real resolver chained directly
  into `prepareChat`, asserting the persona text replaces the mode's own
  persona in the assembled system prompt.
- `src/channels/whatsapp/authState.test.ts`: after `saveCreds`, the raw
  stored row is read back directly, decrypted with the correct secret to
  confirm it round-trips through real encryption (not just non-plaintext),
  and re-saved to confirm two writes of the same creds produce different
  ciphertext (rules out a deterministic encoding).

## Deferred

Nothing rose to the level of a new tracked follow-up - no bugs or invariant
violations were found during this review, only test-coverage gaps, which are
closed above.
