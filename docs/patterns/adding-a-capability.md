# Adding a capability

A new integration — a transport, an optional feature like images or
scheduling, anything that isn't every deployment's problem — is additive:
core doesn't change, and nothing that skips the new subpath pays for it. This
is the checklist version of [packaging.md](../packaging.md)'s subpath rules
and [ADR 0001](../decisions/0001-brain-and-sockets-split.md)'s brain/sockets
split, walked through as steps.

1. **Give it its own directory and subpath**, following an existing one
   (`src/images/`, `src/scheduler/`, `src/flows/`) rather than adding to
   `src/core/`. Heavy or optional dependencies (an SDK, a database client
   only this feature needs) are `peerDependencies` with
   `peerDependenciesMeta.optional`, reached by dynamic import at call time —
   `bun install` and `import "@diegoaltoworks/chatter"` must work with none of
   it configured.

2. **Add a `build:<name>` script** that emits both an `.mjs` and a `.js`
   bundle, externalising the peers the module needs, and chain it into
   `build`.

3. **Add the `exports` key** with `types`/`import`/`require`. This is the
   last step, not the first — `bun run test:pack` (see step 8) packs the real
   tarball and resolves every declared `exports` key against it, so a key
   with no build step behind it fails the contract check immediately rather
   than shipping a 404.

4. **If it's a transport**, implement the `Channel` SPI
   (`src/channels/index.ts`) and build on `createInboundPipeline` rather than
   hand-rolling gates/rate-limits/persona/history — see
   [build-a-channel.md](../build-a-channel.md) for the worked example, and
   [exemplars.md](./exemplars.md) for why the SPI stays that small.

5. **If it needs to answer differently based on caller identity**, use the
   existing seams (`answerFn`, `bucketsFor`) rather than adding a new one —
   see [ARCHITECTURE.md](../ARCHITECTURE.md) invariants 1 and 2 for what each
   one is allowed to do.

6. **If it needs state that must survive a restart**, see
   [adding-a-store.md](./adding-a-store.md) — it does not go in an in-process
   `Map`.

7. **Write the module doc** in `docs/<name>.md` and link it from both
   README.md's Documentation section and docs/index.md's Quick Navigation —
   `scripts/docs-toc.test.ts` fails if either forgets it.

8. **Run `bun run test:pack`.** It builds, packs, and installs the real
   tarball, resolving every subpath under both `import` and `require`, and
   checks the root bundle's size budget — the one check nothing else in
   `bun run check` performs.

## Definition of done

See the table in [CONTRIBUTING.md](../../CONTRIBUTING.md#definition-of-done)
for the same checklist cross-referenced against every kind of change, not
just a new capability.
