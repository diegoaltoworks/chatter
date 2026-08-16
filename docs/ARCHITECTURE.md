# Architecture

What has to stay true for chatter to be the thing described in
[docs/decisions/](./decisions/) — not a wishlist, a list of the invariants
this codebase actually depends on. Each one names the test that fails if it
breaks; an invariant with no enforcing test is marked **aspirational** and
says why it isn't (yet, or ever) a mechanical check.

Read this before touching a seam (`answerFn`, `bucketsFor`, the Channel SPI),
adding a subpath, or adding a store — [docs/patterns/](./patterns/) has the
worked "how do I..." guides; this page is the "why does it have to work that
way" reference they point back to.

## The invariants

1. **Every chat surface answers through `prepareChat` →
   `answerOnce`/`answerStream`; nothing outside `src/core/answer.ts` calls
   `completeOnce`/`completeStream` directly.** A surface that skips the seam
   silently strands a consumer's `answerFn` — the call still succeeds, it
   just never reaches the brain hook. See
   [decisions/0002-no-langchain-in-core.md](./decisions/0002-no-langchain-in-core.md).
   Enforced: `scripts/architecture-invariants.test.ts`.

2. **`bucketsFor` can only widen retrieval for a caller the surface could
   name.** Without a resolvable sender identity, retrieval is clamped to the
   mode's default buckets regardless of what the hook returns — an anonymous
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
   contract check) plus `bun run test:pack` (the impure half — builds, packs,
   installs, and measures the real tarball). See
   [packaging.md](./packaging.md).

5. **CI's supply chain stays intact**: every third-party GitHub Action is
   pinned to a commit SHA with a version comment, Bun is pinned to one exact
   version across every workflow and the Dockerfile, installs use
   `--frozen-lockfile`, and a `dependabot`-authored change never rides a
   release without a human dispatching it. Enforced:
   `scripts/supply-chain.test.ts`, `scripts/release-guard.test.ts`.

6. **Every `docs/*.md` file is linked from both README.md's Documentation
   section and docs/index.md's Quick Navigation section.** A guide nobody can
   find from either entry point might as well not exist. Enforced:
   `scripts/docs-toc.test.ts`.

7. **An async `customRoutes` mount completes before the server is considered
   ready, and a rejecting mount fails start-up instead of yielding a
   half-built app.** A plugin that needs to do async setup (open a
   connection, warm a cache) can trust the app it receives is fully mounted.
   Enforced: `src/server.test.ts`.

8. **Rate/spend state that must survive a restart lives in Turso, never
   process memory** — deployments run multiple instances, and a limiter or
   scheduler claim backed by an in-process `Map` would let each instance
   enforce its own, independent cap. Table creation is idempotent
   (`CREATE TABLE IF NOT EXISTS`) and a claim/reservation is atomic, so two
   instances racing the same key can never both win. Enforced:
   `src/usage/limits.test.ts`, `src/usage/tursoStore.test.ts`,
   `src/scheduler/claimStore.test.ts`. See
   [patterns/adding-a-store.md](./patterns/adding-a-store.md).

9. **Channel-agnostic reply gates (`decideChannelAction`) import nothing from
   the rest of chatter, and never see transport-specific fields.** Mention
   detection, reply-threading, and any other wire-format parsing are the
   transport's job; `src/channels/gates.ts` only combines already-resolved
   booleans with allowlist/mute/rate-limit policy, which is what makes it
   reusable by a channel that doesn't exist yet. Enforced:
   `src/channels/gates.test.ts`. See
   [patterns/exemplars.md](./patterns/exemplars.md).

10. **No commit, PR, code comment, or doc names the reference implementation
    this project was informed by, or attributes work to an AI tool.**
    **Aspirational** — enforced by review discipline, not a test: a lexical
    grep-gate for the forbidden project name would have to embed that name
    somewhere in this repo to check for it, which defeats the rule it exists
    to enforce. There is no test to point to here, on purpose.

## Adding an invariant

A new load-bearing property gets a numbered entry here and, unless it falls
into the same trap as #10, a test named directly above. If the property is
lexical (something a regex over source/config can see — a forbidden call
site, a workflow shape, a doc link), follow the pattern in
`scripts/supply-chain.ts` and `scripts/architecture-invariants.ts`: pure
scanner functions in `scripts/*.ts`, unit-tested in the matching
`*.test.ts`, with a block at the bottom of the test file that runs the
scanner against this repo's actual files. A `*.test.ts` under `scripts/` is
picked up by `bun test` automatically — `bun run check` already runs it, so
a new lexical gate needs no CI workflow change.
