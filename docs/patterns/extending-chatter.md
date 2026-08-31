# Extension points and what they are not for

Chatter has one seam per job, and every seam is documented somewhere in
depth. What is missing is a single page answering "I want to do X, which
seam?" before you've already picked one by matching a noun to your problem.
The load-bearing column below is **not for** - most seams look like they'd
fit a slightly wider job than the one they actually do, and picking the wrong
one compiles fine and fails later, in review or in production.

| Seam | For | Not for | Docs |
| --- | --- | --- | --- |
| `answerFn` | Replacing the completion call itself with your own brain - a different model, a graph framework, a rules engine | Scoping which knowledge a caller can retrieve (`bucketsFor`), or parsing a transport's wire format | [integrations.md](../integrations.md), [ARCHITECTURE.md](../ARCHITECTURE.md) invariant 1 |
| `bucketsFor` | Deciding which knowledge buckets a resolved caller's retrieval draws from | Widening retrieval for a caller the surface can't name - `resolveBuckets` clamps that regardless of what the hook returns | [ARCHITECTURE.md](../ARCHITECTURE.md) invariant 2, [exemplars.md](./exemplars.md) |
| `rewriteQuery` | Reshaping the retrieval query text before it reaches the retriever | Filtering which buckets are visible (`bucketsFor`'s job), or swapping the retrieval backend | [integrations.md](../integrations.md) |
| `rerankContext` | Reordering or trimming chunks after retrieval runs | The access-control seam - it fails open, so a hook that drops chunks a sender shouldn't see silently un-drops them on its own error; scope decisions belong in `bucketsFor` | [integrations.md](../integrations.md) |
| `fallbackFn` | Supplying an answer when retrieval turns up nothing | General-purpose control over the answer - that's the full scope of `answerFn` | [integrations.md](../integrations.md) |
| `transformReply` | Modifying or vetoing the final reply after guardrails have applied | A fail-closed veto - a throwing hook ships the ORIGINAL, untransformed reply, and streaming responses are never consulted at all | [integrations.md](../integrations.md) |
| `refusal` | Overriding the wording of the guardrail refusal line a host running a character speaks in | Weakening the guard itself - detection and credential scrubbing stay fixed; this only voices it | [server.md](../server.md) |
| `retriever` (`config.retriever`) | Swapping the retrieval backend entirely - pgvector, a managed vector database, a service another team runs | Scoping per-caller access to what's already indexed - that's `bucketsFor` | [adding-a-retriever.md](./adding-a-retriever.md) |
| The Channel SPI | Adding a new transport - a name plus `start(deps)`/`stop()` | Embedding chatter inside a host's existing app - that's mounting the returned `ChatterApp` with `app.route()`, not implementing `Channel` | [build-a-channel.md](../build-a-channel.md), [channels.md](../channels.md) |
| `customRoutes` | Mounting a host's own HTTP routes onto the server `createServer` builds | Embedding chatter inside a host's app - that's the Channel SPI row above, mounting the returned `ChatterApp` instead | [server.md](../server.md) |
| `features.headless` | Running chatter with no built-in widget, API surface only | A substitute for building your own server - you still get `createServer`'s app and its routes, just without the widget, demo and static pages | [integrations.md](../integrations.md) |
| The history store (`HistoryStore`) | Swapping where conversation turns are persisted | Changing what counts as a conversation id - the pipeline resolves that before the store ever sees it | [history.md](../history.md) |
| The sender registry (`deps.senders`) | Sending an outbound message through any registered channel from your own code - `customRoutes`, the scheduler | Receiving inbound messages - that's the Channel SPI's job | [server.md](../server.md) |
| Pluggable stores (claim/lease/auth/build-lock) | Swapping persistence for state that must survive a restart and stay correct across instances | Ephemeral in-process state - that never needed a store interface in the first place | [adding-a-store.md](./adding-a-store.md), [ARCHITECTURE.md](../ARCHITECTURE.md) invariant 8 |
| The `intercept` hook | Running your own logic after gates and rate-limiting pass, before persona/buckets/history/`answerOnce`, with identity already resolved | Implementing gate logic itself - mute, allowlist, and addressing (mention / reply-to) are `decideChannelAction`'s job | [build-a-channel.md](../build-a-channel.md) |

## Applying the table

Most of these compose: a turn that falls through `intercept` still gets the
full `bucketsFor` -> `answerFn` path `createInboundPipeline` runs for it, and
a host mounting `customRoutes` still receives the same `deps.senders` and
`deps.identities` a built-in channel does. If your problem doesn't match
any "for" column, it's more likely you need a new pipeline option (see
[adding-a-capability.md](./adding-a-capability.md)) than a new seam - growing
an existing interface is cheaper than it looks, and building around one that
doesn't fit is more expensive than it looks.
