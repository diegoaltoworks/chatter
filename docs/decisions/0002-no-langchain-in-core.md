# ADR 0002: No agent/graph framework in core - `answerFn` is the seam

## Status

Accepted.

## Context

Chatter's chat pipeline is deliberately linear: retrieve, assemble a prompt,
answer once (`prepareChat` -> `answerOnce`/`answerStream` ->
`completeOnce`/`completeStream`). Some deployments need more than that -
multi-step tool calling, a research agent that plans and re-plans, a turn
that fans out to several tools before composing a reply. A graph or agent
framework (LangGraph and similar) is the right tool for that, and consumers
already ask for it.

The tempting shortcut is to add such a framework as a core dependency and let
the pipeline call into it directly. That would buy convenience for the
deployments that want it, and cost every deployment that doesn't: a heavier
install, a larger attack surface, and a framework's release cadence dictating
chatter's.

## Decision

`answerFn` is the entire seam. `src/core/answer.ts`'s `answerOnce` and
`answerStream` check for a configured `answerFn` first and only fall back to
`completeOnce`/`completeStream` (`src/core/llm.ts`) when none is set. A graph
framework - or any other way of producing an answer - plugs in by
implementing `answerFn`; chatter keeps owning retrieval, prompt assembly,
auth, rate limiting, transports, and output guardrails around it. See
[integrations.md](../integrations.md#graph-frameworks-langgraph-and-similar)
for the worked example in both directions (a graph as chatter's brain, and
chatter as one node inside a larger graph).

No agent or graph framework is a dependency, `peerDependency`, or
`optionalDependency` of the package, in core or in any subpath. Choosing one
costs nothing for a deployment that doesn't.

This is the same shape as [ADR 0001](./0001-brain-and-sockets-split.md)
applied to one specific temptation: "the brain" is a hook, not a bundled
implementation, and that stays true even for the brain implementation that
looks most like it wants to live inside core.

## Consequences

- Every chat surface (routes, channels, programmatic use) must call
  `answerOnce`/`answerStream`, never `completeOnce`/`completeStream`
  directly - a direct call bypasses `answerFn` silently. Enforced by
  `scripts/architecture-invariants.test.ts`; see
  [ARCHITECTURE.md](../ARCHITECTURE.md), invariant 1.
- A deployment that wants a graph framework pays for it in its own
  dependencies, not chatter's - `examples/langgraph-brain` shows the wiring
  without chatter depending on LangGraph at all.
- The same restraint applies to any future "obviously useful" framework a
  brain implementation might want: it goes behind `answerFn`, not into
  `core/`'s dependency list.
