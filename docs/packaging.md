# Packaging & the published contract

What a consumer can import from `@diegoaltoworks/chatter`, and how that promise
is kept honest between releases. Every human-authored merge to `main` publishes,
so the contract has to be verified before the merge rather than discovered
downstream. (Dependency bumps are the exception — see
[the release chain](#the-release-chain) below.)

## The subpath contract

The package is deliberately import-shaped: core stays light and each optional
integration lives behind its own subpath, so installing the package never drags
in a dependency you did not ask for.

| Subpath | What it gives you |
| --- | --- |
| `.` | Core: pipeline, brain hook, retrieval, auth, route factories, `createServer` |
| `./server` | The Hono server factory on its own |
| `./client` | Widget classes and their types |
| `./client/style.css` | The widget stylesheet |
| `./mcp` | MCP server factory |
| `./channels` | Channel SPI, reply gates, sender registry, the shared inbound pipeline |
| `./whatsapp` | The built-in WhatsApp channel |
| `./usage` | Daily usage limiter and its Turso store |
| `./history` | Conversation history store contract and its Turso implementation |
| `./personas` | Persona resolver, greeter, time context |
| `./flows` | Slot-filling flow engine |
| `./images` | Image generation with cache-before-spend |
| `./scheduler` | Exactly-once outbound scheduling |
| `./package.json` | The manifest, for tools that read it |

Three rules follow from that shape, and all three are enforced rather than
merely intended:

1. **Every subpath resolves under both `import` and `require`.** Dual-format
   output is not optional — a consumer on either module system gets a working
   module, not a type-only ghost.
2. **A subpath's runtime files are produced by the build.** Declaring a
   condition in `exports` is not the same as building the file it points at.
   Every subpath also has to load when the optional peers are not installed;
   an integration reaches its heavy dependency by dynamic import at call time.
3. **Only the shipped surface ships.** Test declarations and fixtures are
   authored under `src/` but are excluded from the published tree.

## Adding a subpath

Adding a key to `exports` is the *last* step, not the first:

1. Add a `build:<name>` script that emits both an `.mjs` and a `.js` bundle,
   externalising the peer dependencies the module needs, and chain it into
   `build`.
2. Add the peer to `peerDependencies`, with `peerDependenciesMeta.optional`
   when core must install and boot without it.
3. Add the `exports` key with `types`, `import` and `require`.
4. Run `bun run test:pack`.

Declaration files need no step of their own: `tsconfig.build.json` emits them
for the whole `src` tree. That config is narrower than `tsconfig.json` — which
covers tests and build scripts so they typecheck — precisely so tests and
fixtures cannot reach `dist`.

## How it is verified

`bun run test:pack` builds, runs `npm pack`, installs the resulting tarball
into throwaway consumers, and loads every `exports` key under both `import`
and `require`. It runs as its own CI job on every pull request.

It does this twice: once with every peer present, and once with the optional
peers absent — the install a consumer who wants none of the heavy integrations
actually gets. Every subpath must load in both. The optional peers are reached
through dynamic imports at call time, so a static import creeping into one of
those modules would break consumers who never asked for it, and the lean pass
is what notices.

It exists because the failure it catches is invisible to every other gate. A
subpath pointing at a runtime file no build step produces still typechecks for
consumers — tsc reads the `types` condition, and declarations *are* emitted —
and every in-repo test imports from `src/`, never from the package. The bug
only surfaces as `MODULE_NOT_FOUND` in someone else's project, one release too
late.

The check also asserts what it can about non-module keys. A stylesheet subpath
has no meaning to `import` outside a bundler, so for asset keys the contract
verified is that the declared file is really in the tarball.

One consequence worth knowing when writing library code: the consumer process
must exit on its own after importing. A module-scope `setInterval` without
`unref` holds the host's event loop open forever, and `test:pack` fails on the
hang rather than waiting it out.

Before any of that, the same run asserts a size budget (`BUNDLE_BUDGETS` in
`scripts/pack-exports.ts`) on the root entry's built `.mjs`/`.js` files. The
root bundle is every consumer's install size regardless of which subpaths they
touch, so a peer or the widget creeping back into a static import there is a
regression none of the other gates would catch — typecheck, lint and the test
suite all pass whether the root entry is lean or drags in every optional
integration.

## The release chain

Publishing is automated end to end, which makes the chain from an upstream
dependency to the registry worth stating explicitly:

```
merge to main → CI (the gates, plus the build/runtime/tarball/image jobs)
              → publish workflow re-runs the gates, verifies the tarball and
                the Node load, bumps the version, tags,
                `npm publish --provenance`, then cuts the GitHub release
```

The publish workflow cuts the release itself rather than leaving it to a
workflow listening for the tag push. A tag pushed with the default
`GITHUB_TOKEN` does not trigger workflows, so a listener like that never runs —
which is exactly what happened here for the whole tag history while the docs
told readers to look at GitHub Releases for the notes.

It also re-runs `test:pack` and `test:node` itself, rather than trusting the CI
run that triggered it. `workflow_dispatch` is a real release path — it is the
one a maintainer uses to ship a reviewed dependency bump — and it does not pass
through CI at all.

Nobody types a version number: the publish workflow derives the next version
from the highest `v*` tag and commits the bump itself, which is why its own
`chore(release): v…` commit is excluded from re-triggering it. The bump type
carries signal instead of always being a minor: `scripts/next-version.ts`
scans every commit subject since the last tag and ships a minor if any of them
is a `feat` (a `!` breaking-change marker still only reaches minor; `BREAKING
CHANGE:` footers are not read), a patch otherwise (`fix`, `chore`, `docs`, …).
A distinct major-bump tier is reserved for when that matters, post-1.0.

### The human gate

Dependabot opens dependency PRs, a workflow approves and auto-merges the minor
and patch ones, and CI goes green — so without a gate, an upstream maintainer's
code would reach npm under our name with no human having read it.

Two guards close that path, because a bump can reach a release two ways:

- The publish job declines to run when dependabot authored the commit that
  triggered it. That is the auto-merge case, and it costs nothing to check.
- Before publishing anything, the job runs `scripts/release-guard.ts` over
  every commit since the last release tag. Without this, a bump merged on
  Monday ships inside somebody else's Wednesday release — the first guard looks
  at one commit, and the bump is not it.

The second guard distinguishes two kinds of bump, and the distinction is what
keeps it from wedging the release train against itself:

- A bump that edits only a manifest or a lockfile changes which versions this
  package *declares*. No upstream code ships with it, the gates run against it
  like any other commit, and it rides along in the next release.
- A bump that edits a workflow, a Dockerfile or source changes what *runs* —
  the github-actions and docker ecosystems both do this. That one stops the
  automated path.

The earlier version of this guard failed on any dependabot-authored commit at
all, and only a successful publish moves the tag the scan starts from, so a
single routine bump stopped every subsequent release until someone noticed.

A block is skipped for `workflow_dispatch`, which is the point: a maintainer
reviewing the change and running **Publish to NPM** from the Actions tab *is*
the approval, and the release it cuts moves the tag past the commit so ordinary
merges publish again.

### What "CI was green" is allowed to mean

A green run only certifies the release if the run itself is reproducible, so
the whole toolchain is pinned:

- **Actions by commit SHA**, never by tag — a tag is a mutable pointer, and
  these workflows hold `id-token` and `contents: write`. Each pin carries a
  `# vX.Y.Z` comment, which is both how a reader knows what it is and how
  Dependabot knows what to offer.
- **Bun by one exact version**, shared by every workflow step and the
  Dockerfile's base images, so the toolchain that ran the gates is the
  toolchain that builds the tarball. They are checked against each other, since
  the ecosystems that update them are separate and would otherwise drift.
- **`bun install --frozen-lockfile`** everywhere, so CI resolves the committed
  lockfile instead of whatever the registry serves that minute.

Each of these is a line or two that nothing else would notice going missing, so
`scripts/supply-chain.test.ts` audits every workflow in the repo, plus the
Dockerfile, for all of these properties — and for the publish workflow running
the artifact checks itself — ignoring commented-out lines, so a guard
cannot pass the audit as a corpse. Adding a workflow, or pasting a step into an
existing one, fails the gates rather than silently reopening the path.
