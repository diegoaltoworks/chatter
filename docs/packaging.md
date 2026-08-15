# Packaging & the published contract

What a consumer can import from `@diegoaltoworks/chatter`, and how that promise
is kept honest between releases. Every merge to `main` publishes, so the
contract has to be verified before the merge rather than discovered downstream.

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
| `./channels` | Channel SPI, reply gates, sender registry |
| `./whatsapp` | The built-in WhatsApp channel |
| `./usage` | Daily usage limiter and its Turso store |
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
