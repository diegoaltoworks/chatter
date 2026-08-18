# Packaging & the published contract

What a consumer can import from `@diegoaltoworks/chatter`, and how that promise
is kept honest between releases. Every human-authored merge to `main` publishes,
so the contract has to be verified before the merge rather than discovered
downstream.

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

`hono` and `openai` are the only peers *not* marked `optional`. That is
deliberate, not an oversight: `.` (`createServer`) imports and uses both
unconditionally, so per the rule above core cannot install and boot without
them - marking them optional would let `npm install` succeed into a package
that throws the moment it is used. Every other peer (`@hono/node-server`,
`@libsql/client`, `@modelcontextprotocol/sdk`, `@whiskeysockets/baileys`,
`qrcode-terminal`, `zod`) is optional because the subpath that needs it
reaches it through a dynamic import at call time and fails with an
actionable, not a bare `MODULE_NOT_FOUND`, error when it is missing
(`loadServeStatic`, `loadBaileys`, ...).

`@libsql/client` is the one conditional peer: `createServer`/`createMCPServer`
import it only when `config.database` is set - required by default (the
built-in `VectorStore` needs somewhere to keep chunks and embeddings), but
skippable entirely by supplying `config.retriever` instead. See
[patterns/adding-a-retriever.md](./patterns/adding-a-retriever.md).

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
consumer's server is built the default way (`config.database`) and asserts the
widget is actually served; the lean one has no `@libsql/client` either, so it
boots via `config.retriever` instead, asserting both that a config.retriever
host needs none of the optional peers installed and that the missing
`@hono/node-server` peer produces a logged, actionable error rather than a
silent 404. `bun run test:node` cannot catch this on its own - it runs
against the in-tree `dist/`, where devDependencies mean the optional peer is
always present.

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

