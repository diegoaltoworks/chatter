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
}
```

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

`createTursoHistoryStore(client, tableName, maxPerConversation)` is the
shipped binding. It creates its table idempotently on first use (once per
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

## WhatsApp

The built-in WhatsApp channel consumes a `HistoryStore` behind config; see
"Conversation history" in [channels.md](./channels.md). Off by default, so
existing single-turn behavior is unchanged until you wire one in. No other
built-in surface wires history yet — wiring it into a new channel means
loading it before `prepareChat` and appending the turn after, the same two
calls the WhatsApp handler makes.
