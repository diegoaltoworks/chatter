# Exemplars

Three files worth reading before writing something in their shape, because
each one demonstrates a pattern this codebase leans on repeatedly rather than
just solving its own problem.

## `src/core/buckets.ts` - a security invariant as one pure function

`resolveBuckets` is the entire enforcement of "an anonymous caller cannot
widen retrieval into private knowledge" (see
[ARCHITECTURE.md](../ARCHITECTURE.md), invariant 2). Every surface that
accepts a `bucketsFor` hook calls this one function rather than re-deriving
the ceiling itself - the alternative (each route/channel independently
deciding what a hook is allowed to return) would need every one of them to
get the clamp right, forever. When a decision has a correctness or security
property attached, give it one pure function with the invariant spelled out
in a doc comment, and make every caller go through it.

## `src/channels/gates.ts` - transport-agnostic logic, zero imports from chatter

`decideChannelAction` combines mention/reply/allowlist/mute/rate-limit
booleans into a reply/ignore/mute/unmute decision, and imports nothing from
the rest of the package. A transport resolves its own wire format into the
shared `ChannelMessage` shape; this module never sees a jid, a Baileys
session, or any other transport's types. That's what makes it reusable by a
channel that doesn't exist yet - see
[build-a-channel.md](../build-a-channel.md), which wires the exact same
gates into a from-scratch Telegram channel. When a piece of logic is
genuinely transport/backend-agnostic, keep it that way by construction: no
imports from a specific integration, even a convenient one.

## The Channel SPI - the shape a plugin package implements against

`Channel` (`src/channels/index.ts`) is a name and two methods
(`name`, `start(deps)`, optional `stop()`) and nothing else. The built-in
WhatsApp channel implements it, and so does every plugin package outside this
repo (`@diegoaltoworks/talker`'s voice channel included) - see
[ADR 0001](../decisions/0001-brain-and-sockets-split.md). The SPI stays this
small on purpose: everything a channel needs - gates, rate limits, persona
resolution, retrieval scoping, history, the `prepareChat`/`answerOnce` call
itself - comes from `createInboundPipeline`, not from the `Channel` type. A
new capability a channel needs is a new pipeline option, not a new `Channel`
method; growing the interface itself would mean every existing channel
implementation has to change to keep compiling.

## Applying the pattern elsewhere

Looking for the general "how do I add X" version of these? See
[adding-a-capability.md](./adding-a-capability.md) (a new transport,
integration, or subpath) and [adding-a-store.md](./adding-a-store.md) (a new
piece of Turso-backed persistent state).
