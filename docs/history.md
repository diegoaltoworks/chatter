# Conversation History

Channels are single-turn by default: every reply is answered from just the
latest message, with no memory of what came before. `HistoryStore` is a
structural, host-replaceable store for multi-turn context - the
`FlowSessionStore`/`DailyLimitsStore` pattern applied to history. Published as
a subpath so the core install and every channel stay untouched by it until you
opt in:

```ts
import { createTursoHistoryStore } from "@diegoaltoworks/chatter/history";
```

Nothing in this module is WhatsApp- or channel-specific, and it adds no
required dependencies. The interface is pure; only the shipped Turso store
touches a database, and it reuses the `@libsql/client` connection chatter
already holds.

## The contract

```ts
interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
}

interface HistoryStore {
  append(conversationId: string, message: HistoryMessage): Promise<void>;
  load(conversationId: string, limit: number): Promise<HistoryMessage[]>;
  clear(conversationId: string): Promise<void>;
}
```

`clear` is required, not optional: an optional reset primitive would let a
"forget me" feature silently no-op against a store that never implemented it.
A custom `HistoryStore` written before this method existed needs one line
added - `DELETE`/equivalent for the given `conversationId` - to keep
compiling.

`load` returns the most recent `limit` turns, oldest first - ready to spread
directly ahead of the new user message into `prepareChat`/`answerOnce`'s
`messages` array. Any backing store works, as long as `load` respects the
window a caller asks for; a non-positive `limit` returns nothing rather than
the whole conversation.

`limit` is a straight multiplier on prompt size: every loaded turn is a full
message sent to the model on every reply, on top of retrieved context. Pick it
with the same care as a bucket or persona choice, not as an afterthought - see
[usage.md](./usage.md) if that cost needs a cap.

## The conversation key

A channel's turn resolves its `conversationId` from the inbound message: the
`chatId` on its own, or the `chatId` paired with the endpoint that received it
once `ChannelMessage.endpointId` is set. `conversationKeyFor(chatId,
endpointId)` is that rule, exported so a channel of your own keys threads the
same way. Passing an explicit `conversationId` on the turn overrides it
entirely, which is how a channel that already knows its own thread key (a
support ticket id, say) keeps using it.

`chatId` alone is not a thread once a process runs more than one persona. One
guest reaching two of them produces the same `chatId` on both, so a single key
would hand each persona the other's turns. `endpointId` is only ever set by a
channel genuinely running more than one endpoint (see
[channels.md](./channels.md)), so a single-endpoint host's key stays the bare
`chatId` and its stored history keeps reading back - there is nothing to
migrate. The corollary is the one-way door that section describes: a channel
that starts setting an `endpointId` keys its existing threads under new ids,
and the turns recorded before that stay under the old ones. That covers a host
adding a second endpoint, and also a host already running several - its
endpoints were sharing one thread per chat, which is the bug this fixes, and
they start separate threads from the upgrade on.

Both halves are host-chosen strings that may contain the separator, so the
composition escapes both rather than trusting either to avoid it: no two
distinct `chatId`/`endpointId` pairs produce the same key. That guarantee is
about pairs, and does not stretch across the two shapes - a bare `chatId` that
itself contains a `#` can coincide with some other pair's composed key, the
price of leaving the single-endpoint key byte-identical to what is already
stored. Treat the result as opaque: it is a key to store under, not a value to
parse.

## Storage

`createTursoHistoryStore(client, tableName, maxPerConversation, options?)` is
the shipped binding. It creates its table idempotently on first use (once per
client *and* table, matching `./usage` and `./flows`), and every `append`
prunes the conversation back down to `maxPerConversation` (default 200) - so
the table stays bounded even for a conversation whose reader always asks for a
small window. Table names are interpolated into SQL and are therefore
restricted to plain identifiers; anything else throws at construction time.

Build the store on `deps.db` - the libsql handle chatter already opened for
retrieval, passed to `customRoutes` and channels - rather than opening a
second connection of your own. Give each conversation domain **its own
table**, the same rule as `./usage` and `./flows` session storage.

History lives in the database rather than process memory because deployments
run multiple instances - the instance that answers turn 2 of a conversation is
not guaranteed to be the one that answered turn 1.

## Privacy controls

Three primitives, all opt-in, cover the common privacy asks for a store that
remembers what someone said:

**Retention TTL.** `options.ttlMs` bounds how long a turn lives regardless of
`maxPerConversation`. There's no background sweep - rows older than the TTL
are pruned lazily, the next time their conversation is touched by `append` or
`load`:

```ts
createTursoHistoryStore(deps.db, "wa_history", 200, { ttlMs: 30 * 24 * 60 * 60 * 1000 });
```

A conversation nobody ever revisits keeps its rows until it is (there is
nothing to sweep them in the meantime) - pair a TTL with a retention policy
that fits your data, not a false guarantee of prompt deletion.

Compaction (below) defeats a TTL on any conversation it touches: the turns it
keeps are re-appended with a fresh timestamp, and a folded-in summary row
carries content forward from turns of any age. Do not rely on a TTL for
retention on a conversation that also has compaction configured.

**Reset.** `store.clear(conversationId)` erases one conversation's history
immediately - every implementation, not just Turso, must support it. This is
the primitive a "forget me" feature is built from; the engine ships nothing
that decides *when* to call it. A worked example, as a WhatsApp router
`"replace"` detector (see "Multiple detectors" in
[channels.md](./channels.md)):

```ts
{
  name: "forget-me",
  mode: "replace",
  test: (ctx) => /^forget (me|this)\b/i.test(ctx.text),
  handle: async (ctx) => {
    await historyStore.clear(ctx.msg.chatId);
    await ctx.sock.sendMessage(ctx.msg.chatId, { text: "Done - I've cleared this chat's history." });
  },
},
```

**Opt-out.** `historyEnabledFor(sender)` on a channel's `history` config
excludes specific senders from memory entirely - checked before both `load`
and `append`, so an opted-out sender's turns are never read back *and* never
written. `sender` is the same resolved identity `personaResolver`/`answerFn`
see - a phone number on WhatsApp, `tg:<id>` on Telegram:

```ts
history: {
  store: historyStore,
  historyEnabledFor: (sender) => !optedOutSenders.has(sender),
},
```

A throwing predicate fails closed (treated as "not enabled" for that turn,
and logged if a `logger` is configured) - a broken opt-out check must never
silently start recording someone who may have opted out.

Opting out only stops *future* reads and writes; it does not remove what a
sender's turns already added to a conversation's history - call `clear` for
that. And since history is keyed per-*conversation*, not per-sender (a group
chat's history is one shared stream - see [channels.md](./channels.md)), an
opted-out participant in a group still gets a context-free answer while
everyone else's turns keep accumulating around them; opt-out silences one
voice, it doesn't wall off the room.

## Compaction

`limit`/`maxPerConversation` bound what one `load` returns and what a store
physically keeps, but neither one shrinks a conversation that keeps growing -
a chat that never stops still costs the same tokens on every reply once it's
past the window. `createHistoryCompactor` (from
`@diegoaltoworks/chatter/history`) is an opt-in layer that folds older turns
into a single stored summary row once a conversation reaches a configured
turn count, keeping only the most recent turns verbatim.

A channel's `history.compaction` config takes the compaction options
directly - the channel builds and owns the compactor itself, alongside the
`OpenAI` client it already has:

```ts
history: {
  store: historyStore,
  compaction: { threshold: 40, keep: 10 },
},
```

Used standalone (a custom surface wiring `HistoryStore` itself, outside the
built-in channels), `createHistoryCompactor` builds the same compactor
directly:

```ts
import { createHistoryCompactor } from "@diegoaltoworks/chatter/history";

const compactor = createHistoryCompactor({ client }, { threshold: 40, keep: 10 });
await compactor.maybeCompact(historyStore, conversationId); // after each store.append
```

- **`threshold`** - turn count that triggers compaction, checked right after
  each reply is recorded.
- **`keep`** - most recent turns kept verbatim; everything older is folded
  into the summary. Must be less than `threshold`.
- **`summarize`** - the compaction step itself, typically an LLM call.
  Defaults to `answerOnce` with a neutral prompt and the built-in completion
  (never a caller's own `answerFn`, since compaction is an internal chatter
  operation, not a chat surface); set this to route it through your own brain
  hook, a cheaper model, or a non-LLM summarizer instead.
- **`model`** - model for the default `summarize` step; ignored when
  `summarize` is supplied. A channel's `history.compaction` defaults this to
  the channel's own `model` config.
- **`timeoutMs`** (default 8000) - how long `summarize` gets before
  compaction is abandoned for that turn, leaving history untouched. The
  race-a-timeout, fall-back-safely shape matches `./images`'
  `composeCaption`.

Compaction runs after the reply is sent, never before - it's housekeeping for
the *next* turn, not a precondition for this one, so a slow or failing
`summarize` step never delays or breaks the current reply.

The summary is written back through the same `store.append`/`store.clear`
calls any host code could make, tagged with a fixed prefix ("Summary of
earlier conversation: ..."), so it loads back and participates in
`prepareChat` context exactly like a real turn on the next reply. This rewrite
is clear-then-append, not one atomic operation - a process crash mid-rewrite
could lose the turns being kept, an accepted tradeoff of a store contract with
no transaction primitive. A failing or timed-out `summarize` never reaches
that rewrite at all: history is left exactly as it was, and the turn's own
reply still sends normally.

## Channels

Every built-in channel - WhatsApp, Telegram, Matrix - accepts the same
`history` config (`store`, `limit`, `historyEnabledFor`, `compaction`) and
consumes a `HistoryStore` through `createInboundPipeline`; see "Conversation
history" in [channels.md](./channels.md). Off by default, so existing
single-turn behavior is unchanged until you wire one in. A channel built the
documented way (see [Building a Channel](./build-a-channel.md)) just passes
`history` through to `createInboundPipeline` and hand-rolls nothing; only a
channel that bypasses the shared pipeline has to load history before
`prepareChat` and append the turn after itself, the two calls
`createInboundPipeline` makes on every channel's behalf.
