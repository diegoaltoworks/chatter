# Architecture

What has to stay true for chatter to be the thing described in
[docs/decisions/](./decisions/) - not a wishlist, a list of the invariants
this codebase actually depends on. Each one names the test that fails if it
breaks; an invariant with no enforcing test is marked **aspirational** and
says why it isn't (yet, or ever) a mechanical check.

Read this before touching a seam (`answerFn`, `bucketsFor`, the Channel SPI),
adding a subpath, or adding a store - [docs/patterns/](./patterns/) has the
worked "how do I..." guides, and
[patterns/extending-chatter.md](./patterns/extending-chatter.md) indexes
every seam against what it is and is not for; this page is the "why does it
have to work that way" reference they point back to.

## The invariants

1. **Every chat surface answers through `prepareChat` ->
   `answerOnce`/`answerStream`; nothing outside `src/core/answer.ts` calls
   `completeOnce`/`completeStream` directly.** A surface that skips the seam
   silently strands a consumer's `answerFn` - the call still succeeds, it
   just never reaches the brain hook. This is about chat surfaces
   specifically: `src/flows/intent.ts` and `src/flows/params.ts` call the
   OpenAI client directly for flow classification and slot extraction, which
   never becomes a reply sent to the user, so they are not chat surfaces and
   are outside this invariant's scope (documented inline at each call site).
   See
   [decisions/0002-no-langchain-in-core.md](./decisions/0002-no-langchain-in-core.md).
   Enforced: `scripts/architecture-invariants.test.ts`.

2. **`bucketsFor` can only widen retrieval for a caller the surface could
   name.** Without a resolvable sender identity, retrieval is clamped to the
   mode's default buckets regardless of what the hook returns - an anonymous
   public request can never read `private` knowledge by way of a
   misconfigured hook. Enforced: `src/core/buckets.test.ts`.

3. **A client-supplied `model` field is never honoured.** Every chat surface
   dispatches with the server's configured model; nothing a caller sends
   changes which model answers. Enforced: `src/routes/openai.test.ts`
   ("ignores client-supplied model and uses the configured one").

4. **Every published `exports` subpath resolves under both `import` and
   `require` from the actual packed tarball, and the root bundle (`.`) stays
   under its size budget.** Declaring a condition in `package.json#exports`
   is not the same as a build step producing the file it points at, and a
   creeping static import of an optional peer is invisible to
   typecheck/lint/test. Enforced: `scripts/pack-exports.test.ts` (the pure
   contract check) plus `bun run test:pack` (the impure half - builds, packs,
   installs, and measures the real tarball). See
   [packaging.md](./packaging.md).

5. **CI's supply chain stays intact**: every third-party GitHub Action is
   pinned to a commit SHA with a version comment, Bun is pinned to one exact
   version across every workflow and the Dockerfile, installs use
   `--frozen-lockfile`, and a `dependabot`-authored change never rides a
   release without a human dispatching it. Enforced:
   `scripts/supply-chain.test.ts`, `scripts/release-guard.test.ts`.

6. **Every markdown file under `docs/`, including `decisions/` and
   `patterns/`, is linked from both README.md's Documentation section and
   docs/index.md's Quick Navigation section.** A guide nobody can find from
   either entry point might as well not exist. Enforced:
   `scripts/docs-toc.test.ts`. Every relative link in tracked markdown
   resolves to a file that exists, and to a real heading when it carries a
   `#fragment`, so a renamed guide or a retitled section cannot leave a
   dangling cross-reference. Enforced: `scripts/docs-links.test.ts`.

7. **An async `customRoutes` mount completes before the server is considered
   ready, and a rejecting mount fails start-up instead of yielding a
   half-built app.** A plugin that needs to do async setup (open a
   connection, warm a cache) can trust the app it receives is fully mounted.
   Enforced: `src/server.test.ts`.

8. **State that must survive a restart lives behind a shared,
   multi-instance-safe store interface, never process memory** - deployments
   run multiple instances, and a limiter, scheduler claim, deploy lease, or
   auth-state cache backed by an in-process `Map` would let each instance
   enforce its own, independent view. libsql (Turso) is the shipped
   implementation (`createTursoScheduleClaimStore`, `createTursoWaLeaseStore`,
   `createTursoWaAuthKV`, `createTursoBuildLock`, `usage/tursoStore.ts`); table
   creation is idempotent
   (`CREATE TABLE IF NOT EXISTS`) and a claim/reservation is atomic, so two
   instances racing the same key can never both win. Every such store's
   config field (`SchedulerConfig.claimStore`,
   `WhatsAppChannelConfig.leaseStore`/`authStore`,
   `VectorStoreOptions.buildLock`) is injectable, defaulting
   to the Turso-backed factory only when unset - a caller can swap in a
   different backend without touching the seam that consumes it. Enforced:
   `src/usage/limits.test.ts`, `src/usage/tursoStore.test.ts`,
   `src/scheduler/claimStore.test.ts`, `src/scheduler/scheduler.test.ts`,
   `src/channels/whatsapp/channel.test.ts`, `src/core/buildLock.test.ts`. See
   [patterns/adding-a-store.md](./patterns/adding-a-store.md).

   Holding such a lease also obliges the holder to keep using it: this
   channel may never simultaneously hold a session's lease, have no live
   socket for it, and have no retry scheduled. That combination is invisible
   from the outside (the process still passes health checks and still renews
   the lease) and never resolves on its own, so every failed connect attempt
   releases the session and re-enters the same lease-gated retry loop, on the
   same backoff a closed connection uses. This matters most for an attempt
   that throws before Baileys returns a socket at all - a database blip while
   loading auth state, say - because there is then no socket to fire the
   "close" event the reconnect path would otherwise recover from. Exactly one
   path may recover a session: giving one up is a synchronous claim, so a
   heartbeat that lost the lease and a connect that threw in the same tick
   cannot both start a retry chain and end up with two sockets on one number.
   Enforced: `src/channels/whatsapp/channel.test.ts` ("a reconnect whose
   connect() throws re-enters the retry loop instead of dead-ending", "a
   failed connect and a heartbeat that lost the lease start one retry chain,
   not two").

   The same rule covers work that is destructive rather than metered:
   `VectorStore.build()` deletes every chunk its own `knowledgeDir` did not
   produce, so it runs under a single-writer lock (`chatter_build_lock`) held
   for the whole ingest. A second instance booting mid-build takes no
   destructive action at all, rather than diffing against a database the
   holder is still writing. Enforced: `src/core/retrieval.test.ts` ("a build
   that starts while another is in flight skips its destructive delete
   phase").

9. **Channel-agnostic reply gates (`decideChannelAction`) import nothing from
   the rest of chatter, and never see transport-specific fields.** Mention
   detection, reply-threading, and any other wire-format parsing are the
   transport's job; `src/channels/gates.ts` only combines already-resolved
   booleans with allowlist/mute/rate-limit policy, which is what makes it
   reusable by a channel that doesn't exist yet. Enforced:
   `src/channels/gates.test.ts`. See
   [patterns/exemplars.md](./patterns/exemplars.md).

10. **No commit, PR, code comment, or doc names the reference implementation
    this project was informed by, or attributes work to an AI tool.** The
    actual forbidden project name is **aspirational** - enforced by review
    discipline, not a test: a lexical grep-gate for it would have to embed
    that name somewhere in this repo to check for it, which defeats the rule
    it exists to enforce. There is no test to point to here, on purpose. A
    narrower, mechanically-checkable piece of the same rule *is* enforced,
    though: a source-code comment naming "the reference implementation" (the
    sanctioned neutral term prose is allowed to use, per process.md) as
    provenance is a leak of development history a comment shouldn't carry.
    Enforced: `scripts/comment-gate.test.ts`.

11. **A comment does not hardcode this package's current released version, does
    not reference a tracker ticket id, and any `path:line` anchor it makes
    points at a file and line that actually exist.** All three go stale
    silently: the version the moment the next merge auto-publishes, a ticket
    id the moment the ticket closes, an anchor the moment the target file
    moves or shrinks. An em-dash anywhere in tracked source or docs is also
    checked, against a ratchet baseline that may only decrease (see
    CONTRIBUTING.md's "No em-dashes"). Enforced: `scripts/comment-gate.test.ts`.

## Conventions

Not invariants (nothing enforces them, and breaking one isn't a correctness
bug), but decisions worth writing down so they don't get re-litigated file
by file.

- **Prefer an exported factory function (`createX`) returning a plain
  object/interface over an exported class.** A factory separates
  construction from the interface a caller programs against, which is what
  makes a store, limiter, or hook swappable (see invariant 8). Most of the
  codebase already follows this - `createTursoHistoryStore`,
  `createFlowEngine`, `createScheduler`, `createShortener`, and so on. A
  handful of exported classes predate this convention or are genuinely
  stateful objects a caller is expected to hold onto and call methods on
  repeatedly (`ApiKeyManager`, `PromptLoader`) rather than a seam a host
  swaps out; they are public API, so normalizing them to factories now would
  be a breaking change for no behavioral gain. Don't add a new exported
  class without a reason beyond habit.

## Adding an invariant

A new load-bearing property gets a numbered entry here and, unless it falls
into the same trap as #10, a test named directly above. If the property is
lexical (something a regex over source/config can see - a forbidden call
site, a workflow shape, a doc link), follow the pattern in
`scripts/supply-chain.ts` and `scripts/architecture-invariants.ts`: pure
scanner functions in `scripts/*.ts`, unit-tested in the matching
`*.test.ts`, with a block at the bottom of the test file that runs the
scanner against this repo's actual files. A `*.test.ts` under `scripts/` is
picked up by `bun test` automatically - `bun run check` already runs it, so
a new lexical gate needs no CI workflow change.
