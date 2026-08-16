# ADR 0003: Slot-filling is brain territory

## Status

Accepted.

## Context

A meaningful share of real chat surfaces need more than "retrieve, then
answer once" - booking a slot, collecting a shipping address, walking through
a multi-field form over several turns. That's slot-filling: a structured
interaction with its own state machine, distinct from the RAG chat pipeline
`prepareChat`/`answerOnce` implements.

Two places could own it: baked into the core pipeline as a mode every chat
turn can enter, or as an opt-in layer a deployment reaches for only when it
needs structured, multi-turn collection.

## Decision

Slot-filling lives in `./flows` (`src/flows/`) - a directory-loaded,
schema-driven engine (`flow.json`/`handler.ts`/`instructions.md` per flow,
hybrid keyword + LLM intent matching, Turso-backed session state for
multi-instance safety) that a channel or route opts into. It is not a mode of
`prepareChat`, and the core pipeline has no notion of "which slot is being
filled right now."

This follows the same split as [ADR 0001](./0001-brain-and-sockets-split.md):
`prepareChat`/`answerOnce` is retrieval-and-one-answer, full stop. Anything
that needs multi-step state - slot-filling, a graph-based agent (see
[ADR 0002](./0002-no-langchain-in-core.md)), a custom `intercept` hook - is
brain territory: a capability a deployment adds on top of the pipeline, not a
branch inside it. Flows and `answerFn` are two different answers to "the
pipeline isn't enough for this turn"; a deployment can use either, both, or
neither.

## Consequences

- `prepareChat` stays linear and framework-free regardless of how many
  deployments use flows - see
  [integrations.md](../integrations.md#when-does-a-graph-fit) for the same
  question asked about graph frameworks instead of flows.
- A channel wires flows in explicitly (see [flows.md](../flows.md) and
  `docs/build-a-channel.md`'s `intercept` hook) rather than inheriting them
  automatically; a surface that never needs structured collection carries no
  cost for the ones that do.
- If a future capability needs multi-turn state the way flows does, it
  follows the same shape: an opt-in module behind its own subpath, not a new
  branch in `prepareChat`.
