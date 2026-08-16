# Conversation History

Channels are single-turn by default: every reply is answered from just the
latest message, with no memory of what came before. `HistoryStore` is a
structural, host-replaceable store for multi-turn context — the
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
added — `DELETE`/equivalent for the given `conversationId` — to keep
compiling.

`load` returns the most recent `limit` turns, oldest first — ready to spread
directly ahead of the new user message into `prepareChat`/`answerOnce`'s
`messages` array. Any backing store works, as long as `load` respects the
window a caller asks for; a non-positive `limit` returns nothing rather than
the whole conversation.

`limit` is a straight multiplier on prompt size: every loaded turn is a full
message sent to the model on every reply, on top of retrieved context. Pick it
with the same care as a bucket or persona choice, not as an afterthought — see
[usage.md](./usage.md) if that cost needs a cap.

## Storage

`createTursoHistoryStore(client, tableName, maxPerConversation, options?)` is
the shipped binding. It creates its table idempotently on first use (once per
client *and* table, matching `./usage` and `./flows`), and every `append`
prunes the conversation back down to `maxPerConversation` (default 200) — so
the table stays bounded even for a conversation whose reader always asks for a
small window. Table names are interpolated into SQL and are therefore
restricted to plain identifiers; anything else throws at construction time.

Build the store on `deps.db` — the libsql handle chatter already opened for
retrieval, passed to `customRoutes` and channels — rather than opening a
second connection of your own. Give each conversation domain **its own
table**, the same rule as `./usage` and `./flows` session storage.

History lives in the database rather than process memory because deployments
run multiple instances — the instance that answers turn 2 of a conversation is
not guaranteed to be the one that answered turn 1.

## Privacy controls

Three primitives, all opt-in, cover the common privacy asks for a store that
remembers what someone said:

**Retention TTL.** `options.ttlMs` bounds how long a turn lives regardless of
`maxPerConversation`. There's no background sweep — rows older than the TTL
are pruned lazily, the next time their conversation is touched by `append` or
`load`:

```ts
createTursoHistoryStore(deps.db, "wa_history", 200, { ttlMs: 30 * 24 * 60 * 60 * 1000 });
```

A conversation nobody ever revisits keeps its rows until it is (there is
nothing to sweep them in the meantime) — pair a TTL with a retention policy
that fits your data, not a false guarantee of prompt deletion.

**Reset.** `store.clear(conversationId)` erases one conversation's history
immediately — every implementation, not just Turso, must support it. This is
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
    await ctx.sock.sendMessage(ctx.msg.chatId, { text: "Done — I've cleared this chat's history." });
  },
},
```

**Opt-out.** `historyEnabledFor(sender)` on a channel's `history` config
excludes specific senders from memory entirely — checked before both `load`
and `append`, so an opted-out sender's turns are never read back *and* never
written. `sender` is the same resolved identity `personaResolver`/`answerFn`
see — a phone number on WhatsApp, `tg:<id>` on Telegram:

```ts
history: {
  store: historyStore,
  historyEnabledFor: (sender) => !optedOutSenders.has(sender),
},
```

A throwing predicate fails closed (treated as "not enabled" for that turn,
and logged if a `logger` is configured) — a broken opt-out check must never
silently start recording someone who may have opted out.

Opting out only stops *future* reads and writes; it does not remove what a
sender's turns already added to a conversation's history — call `clear` for
that. And since history is keyed per-*conversation*, not per-sender (a group
chat's history is one shared stream — see [channels.md](./channels.md)), an
opted-out participant in a group still gets a context-free answer while
everyone else's turns keep accumulating around them; opt-out silences one
voice, it doesn't wall off the room.

## WhatsApp

The built-in WhatsApp channel consumes a `HistoryStore` behind config; see
"Conversation history" in [channels.md](./channels.md). Off by default, so
existing single-turn behavior is unchanged until you wire one in. No other
built-in surface wires history yet — wiring it into a new channel means
loading it before `prepareChat` and appending the turn after, the same two
calls the WhatsApp handler makes.
