# Packaging & the published contract

What a consumer can import from `@diegoaltoworks/chatter`, and how that promise
is kept honest between releases. Every human-authored merge to `main` publishes,
so the contract has to be verified before the merge rather than discovered
downstream. (Dependency bumps are the exception - see
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
| `./telegram` | The built-in Telegram Bot API channel (no peer dependency) |
| `./matrix` | The built-in Matrix client-server API channel (no peer dependency; unencrypted rooms only) |
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
   output is not optional - a consumer on either module system gets a working
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
for the whole `src` tree. That config is narrower than `tsconfig.json` - which
covers tests and build scripts so they typecheck - precisely so tests and
fixtures cannot reach `dist`.

## Peer tiers

`hono`, `openai` and `@libsql/client` are the only peers *not* marked
`optional`. That is deliberate, not an oversight: `.` (`createServer`)
imports and uses all three unconditionally, so per the rule above core cannot
install and boot without them - marking them optional would let
`npm install` succeed into a package that throws the moment it is used.
Every other peer (`@hono/node-server`, `@modelcontextprotocol/sdk`,
`@whiskeysockets/baileys`, `qrcode-terminal`, `zod`) is optional because the
subpath that needs it reaches it through a dynamic import at call time and
fails with an actionable, not a bare `MODULE_NOT_FOUND`, error when it is
missing (`loadServeStatic`, `loadBaileys`, ...).

The one tier this cannot fix: `./client` (the widget) uses none of the above
- `src/client/package.json` declares zero peers of its own - but npm's peer
model is package-wide, not subpath-scoped, so `npm install
@diegoaltoworks/chatter` for the widget alone still resolves every mandatory
peer of `.`. There is no `exports`-aware peer syntax to fix that with. The
documented, zero-install path for the widget (`<script src=".../chatter.js">`,
see [docs/client.md](./client.md)) sidesteps it entirely; an npm consumer who
truly only wants `./client` can drop the peers with `npm install --omit=peer`
(or the pnpm/yarn equivalent), since none of the widget's code ever touches
them.

## How it is verified

`bun run test:pack` builds, runs `npm pack`, installs the resulting tarball
into throwaway consumers, and loads every `exports` key under both `import`
and `require`. It runs as its own CI job on every pull request.

It does this twice: once with every peer present, and once with the optional
peers absent - the install a consumer who wants none of the heavy integrations
actually gets. Every subpath must load in both. The optional peers are reached
through dynamic imports at call time, so a static import creeping into one of
those modules would break consumers who never asked for it, and the lean pass
is what notices.

It exists because the failure it catches is invisible to every other gate. A
subpath pointing at a runtime file no build step produces still typechecks for
consumers - tsc reads the `types` condition, and declarations *are* emitted -
and every in-repo test imports from `src/`, never from the package. The bug
only surfaces as `MODULE_NOT_FOUND` in someone else's project, one release too
late.

Resolving isn't the same as running: each of the two consumers also boots a
real server from the tarball and requests `/chatter.js`, under real Node (not
Bun - see `scripts/boot-check.mjs` for why that distinction matters here,
and why the module is shared verbatim with `bun run test:node`). The full
consumer asserts the widget is actually served; the
lean one asserts the missing `@hono/node-server` peer produces a logged,
actionable error rather than a silent 404. `bun run test:node` cannot catch
this on its own - it runs against the in-tree `dist/`, where devDependencies
mean the optional peer is always present.

Bins are checked too, since `package.json#bin` sits outside `exports` and
nothing else touches it: the tarball must contain every declared bin target,
and each one is run with `--help` from inside the full consumer, the way
`npx <bin>` would.

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
regression none of the other gates would catch - typecheck, lint and the test
suite all pass whether the root entry is lean or drags in every optional
integration.

## The release chain

Publishing is automated end to end, which makes the chain from an upstream
dependency to the registry worth stating explicitly:

```
merge to main -> CI (the gates, plus the build/runtime/tarball/image jobs)
              -> the release job refuses an unreviewed dependency change, then
                opens a release PR carrying the version bump
              -> CI on the release PR (dispatched explicitly - see below),
                waited for in the same run
              -> the release job merges the PR itself once that CI passes
              -> the same run re-runs the gates, verifies the tarball and the
                Node load, `npm publish --provenance`, then cuts the GitHub
                release (which creates the tag)
```

The commit actually released is read from the merged PR's own `mergeCommit`,
not from the tip of `origin/main` after the merge - a human push landing on
`main` in the gap between the squash-merge and a later `git fetch` would
otherwise move that tip past the release commit, and the rest of the run
would check out and publish the wrong tree under the version it just bumped
to.

Publishing itself uses npm's OIDC trusted publishing rather than a long-lived
`NPM_TOKEN`: the job already carries `id-token: write`, so `npm publish`
exchanges that identity for a short-lived credential directly with the
registry (a recent npm client is installed first, since the exchange needs
one). This depends on the package's trusted-publisher settings on npmjs.com
naming this exact repository and `npm-publish.yml` as an authorized
publisher - done once, out of band, not something this workflow can verify
about itself.

The publish workflow never pushes to `main` directly - the release PR's merge
is the only thing that lands a release commit there. That was built so this
stays compatible with a `required_status_checks` rule on `main-protection`,
which blocks any push of a commit that has not itself already passed the
check; `GITHUB_TOKEN`, which is all this workflow runs as, has no bypass on
the ruleset (only the repository-admin role does), so a job pushing straight
to `main` would be unable to release at all under that rule. See
[ADR 0004](./decisions/0004-main-protection-stays-non-fast-forward-only.md)
for why that rule is not currently enabled despite the release flow being
built for it: it was turned on once, and `GITHUB_TOKEN`'s own PR merges got
stuck (GitHub's `mergeable_state` reported `blocked` indefinitely even with
every required check green), wedging the release train until an admin merged
by hand. The release-PR routing stays regardless, since it's what a
re-attempt would need.

Opening the PR, pushing its branch, and merging it all go through
`GITHUB_TOKEN`, and GitHub does not let a `GITHUB_TOKEN`-created push, pull
request, or merge trigger other workflows - the guard that stops an action
from recursively triggering itself. Two things follow from that, and both are
why this is one job rather than a release job and a separate listener:

- Left alone, CI would never run on the release branch, so nothing would ever
  post a status for a merge to wait on. `workflow_dispatch` is exempt from
  that guard, so the release job dispatches CI on the release branch
  explicitly, then waits for that specific run (`gh run watch`) before doing
  anything else.
- The merge itself is also a `GITHUB_TOKEN` push to `main`, so it does not
  retrigger CI either - a design that merged the PR and then waited for a
  fresh `workflow_run` on `main` to publish would wait forever, on every
  release after the first. The same run that merges the PR keeps going and
  does the publishing itself, with no second trigger to wait on. A version
  bump can therefore land on `main` with nothing published yet if this run
  dies between the merge and the publish; the next run's first step checks
  for exactly that (`package.json`'s version ahead of the latest tag) and
  finishes that release - from the actual `chore(release): v...` commit found
  by message, not from whatever is at `HEAD` by then, which is already the
  next merge past it - instead of starting a new one.

A release can also get stuck the other way: if CI never goes green on the
release branch, the PR is left open rather than closed automatically, and
every run after that refuses to open a second, competing release PR - loudly
(the job fails) rather than quietly, since a green "nothing to do" run would
hide a wedged release train behind an ordinary-looking Actions log. Closing or
fixing the stuck PR by hand is what unsticks it.

Nobody types a version number: the release job derives the next version from
the highest `v*` tag and opens the release PR with the bump already committed,
which is why the resulting `chore(release): v...` commit is excluded from
re-triggering the job - moot in practice, since that commit's merge does not
retrigger CI at all, but real protection against a human manually re-running
CI on it. The bump type carries signal instead of always being a minor:
`scripts/next-version.ts` scans every commit since the last tag and ships a
minor if any of them is a `feat`, a patch otherwise (`fix`, `chore`, `docs`,
...), and a major if any of them is breaking (a `!` before the colon, or a
`BREAKING CHANGE:` / `BREAKING-CHANGE:` footer) - but only once the package is
past 1.0. Before 1.0 a breaking commit still only reaches minor, the strongest
tier semver defines for 0.x. A husky `commit-msg` hook runs `commitlint`
against `commitlint.config.js` locally, but the commits `next-version.ts`
actually scans are the squash-merge commits on `main`, whose subjects are
human-written PR titles - composed on GitHub, never passed through the hook.
The hook catches a typo'd type on the commits inside a branch; a mistyped PR
title still falls back to patch silently.

### The human gate

Dependabot opens dependency PRs, a workflow approves and auto-merges the minor
and patch ones, and CI goes green - so without a gate, an upstream maintainer's
code would reach npm under our name with no human having read it.

Two guards close that path, because a bump can reach a release two ways:

- The release job declines to open a release PR when dependabot authored the
  commit that triggered it. That is the auto-merge case, and it costs nothing
  to check.
- Before opening a release PR - or resuming one already merged, in the
  stranded-release case above - the same job runs `scripts/release-guard.ts`
  over every commit since the last release tag. Without this, a bump merged on
  Monday ships inside somebody else's Wednesday release - the first guard looks
  at one commit, and the bump is not it. It runs this early deliberately: a
  block found only after the version bump had already merged to main would
  leave main dirty with nothing able to finish that release.

The second guard distinguishes two kinds of bump, and the distinction is what
keeps it from wedging the release train against itself:

- A bump that edits only a manifest or a lockfile changes which versions this
  package *declares*. No upstream code ships with it, the gates run against it
  like any other commit, and it rides along in the next release.
- A bump that edits a workflow, a Dockerfile or source changes what *runs* -
  the github-actions and docker ecosystems both do this. That one stops the
  automated path.

The earlier version of this guard failed on any dependabot-authored commit at
all, and only a successful publish moves the tag the scan starts from, so a
single routine bump stopped every subsequent release until someone noticed.

A block is skipped for `workflow_dispatch`, which is the point: a maintainer
reviewing the change and running **Publish to NPM** from the Actions tab *is*
the approval, and the release it cuts moves the tag past the commit so ordinary
merges publish again. Opening the release PR, merging it, and publishing all
happen in the one job a dispatched run triggers, so that approval needs no
extra plumbing to carry across a trigger boundary - the same `github.event_name`
check that skipped the guard before the release-PR split still does.

### What "CI was green" is allowed to mean

A green run only certifies the release if the run itself is reproducible, so
the whole toolchain is pinned:

- **Actions by commit SHA**, never by tag - a tag is a mutable pointer, and
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
Dockerfile, for all of these properties - and for the publish workflow running
the artifact checks itself - ignoring commented-out lines, so a guard
cannot pass the audit as a corpse. Adding a workflow, or pasting a step into an
existing one, fails the gates rather than silently reopening the path.
