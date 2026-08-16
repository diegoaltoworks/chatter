# ADR 0001: Chatter is the brain plus the sockets plugins plug into

## Status

Accepted.

## Context

Chatter started as a single embeddable chatbot server: RAG, auth, rate
limiting, a widget, one deployment shape. Two things pushed on that shape at
once - a WhatsApp channel needed to plug in as a transport without forking
the request pipeline, and `@diegoaltoworks/talker` (telephony/voice) needed
the same seams from a separate package, not a copy of chatter's internals.

Two different designs would have "worked": grow chatter into a monolith that
also owns every transport and every brain implementation, or split retrieval,
prompting, and transport into separately-versioned packages that each
consumer wires together by hand.

## Decision

Chatter owns two things and stays out of a third:

- **The brain**: retrieval (`prepareChat`), the completion seam
  (`answerOnce`/`answerStream`, honouring a configured `answerFn`), auth, rate
  limiting, output guardrails, personas, metering, and one built-in channel
  (WhatsApp) that dogfoods the plugin surface it defines for everyone else.
- **The sockets**: a small set of typed seams - the Channel SPI
  (`src/channels/index.ts`), `answerFn`, `bucketsFor`, `HistoryStore`,
  `ScheduleClaimStore` - that a plugin package implements against, published
  behind optional subpath exports (`./channels`, `./whatsapp`, `./flows`,
  ...) so installing chatter never drags in a transport or an integration a
  deployment doesn't use.
- **Not** every transport, and **not** every brain implementation. A voice
  channel, a different LLM orchestration framework, a different persistence
  backend - those are plugins, built against the sockets, versioned and
  released independently.

`@diegoaltoworks/talker` is the first consumer of that split: it is a plugin
package, not a fork, and every seam it needs is one this repo already ships
for the built-in WhatsApp channel to use.

## Consequences

- A new transport or integration is additive: a new subpath export plus a
  seam implementation, never a change to `core/`. See
  [patterns/adding-a-capability.md](../patterns/adding-a-capability.md).
- Core has to stay honest about what's actually core. A capability that only
  one deployment shape needs belongs behind a subpath, not folded into `.`
  - see [ADR 0002](./0002-no-langchain-in-core.md) for the sharpest version
  of that rule.
- The built-in WhatsApp channel is held to the same Channel SPI a third-party
  plugin would use, on purpose - see
  [build-a-channel.md](../build-a-channel.md), which proves the SPI is
  sufficient by implementing a second, independent channel (Telegram) against
  nothing but the public seam.
