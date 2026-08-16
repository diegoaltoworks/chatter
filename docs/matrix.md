# Matrix Channel

Run a chatter bot on [Matrix](https://matrix.org) over the plain client-server
HTTP API — the third built-in transport on the
[Channel SPI](./build-a-channel.md), and, like [Telegram](./telegram.md), the
cheapest to adopt: the client-server API is JSON over HTTPS (plus one
raw-bytes endpoint for media), so `./matrix` adds **no dependency at all** —
not even an optional peer.

```ts
import { createServer } from "@diegoaltoworks/chatter/server";
import { createMatrixChannel } from "@diegoaltoworks/chatter/matrix";

await createServer({
  // ...your usual config
  channels: [
    createMatrixChannel({
      homeserverUrl: process.env.MATRIX_HOMESERVER_URL as string,
      accessToken: process.env.MATRIX_ACCESS_TOKEN as string,
    }),
  ],
});
```

That is the whole minimum. Everything past turning a room event into a
message — allowlist/mute gates, reply rate limits, persona resolution,
retrieval buckets, history, the `answerFn` brain hook — is the shared inbound
pipeline every channel runs.

## ⚠️ No end-to-end encryption support

**This is the one thing to understand before wiring this channel in.** Matrix
clients encrypt rooms by default — most personal homeservers (matrix.org
included) turn on E2EE for a new DM automatically, and many clients default
new group rooms to encrypted too. This channel speaks the plain
client-server API only: it has no Olm/Megolm implementation, no device keys,
no cross-signing. An encrypted room's events arrive as opaque
`m.room.encrypted` ciphertext, which this channel silently cannot decrypt —
they are dropped, not queued or retried, because there is nothing here that
could ever read them.

**Use this channel only in rooms explicitly created unencrypted.** When
inviting the bot, create the room (or DM) with encryption turned off — most
clients offer this as a toggle at room-creation time, off by default only for
public rooms. A DM to the bot from a client that defaults new DMs to
encrypted will never be seen. Decrypting Matrix traffic is out of scope for
this v1; it would need an Olm/Megolm implementation (a real dependency, not a
`fetch` call) and is parked as a possible follow-up, not started here.

## Getting a bot account and access token

1. Register a dedicated user on your homeserver for the bot (never reuse a
   human account) — via your homeserver's registration API, an admin API, or
   any Matrix client.
2. Get that account's access token. The simplest way for a bot that will run
   unattended is a **login** call, which does not expire the way a client
   session's token typically does:

   ```bash
   curl -X POST 'https://matrix.example.org/_matrix/client/v3/login' \
     -H 'Content-Type: application/json' \
     -d '{"type":"m.login.password","identifier":{"type":"m.id.user","user":"mybot"},"password":"..."}'
   ```

   The response's `access_token` is the credential this channel needs. Keep
   it in the environment, never in the repo — chatter never logs it: any
   error text that could contain it is redacted to `***` before it reaches a
   log line (see `redactToken` in `./matrix`).
3. Invite the bot to a room. `autoJoin` (on by default) accepts the invite
   automatically the next sync after it arrives — no separate join step
   needed.

## Configuration

| Option | Default | What it does |
| --- | --- | --- |
| `homeserverUrl` | *(required)* | The bot account's homeserver client-server API origin. |
| `accessToken` | *(required)* | From a login call — see above. |
| `name` | `"matrix"` | Channel and sender-registry name. Give each bot its own when running several in one process. |
| `allowedChats` | `[]` (all) | Group room ids eligible for a reply. DMs always reply. |
| `answerFn` / `bucketsFor` / `rewriteQuery` / `rerankContext` / `transformReply` | `deps.config.*` | The brain, retrieval-scope, retrieval-shaping and outbound-reply hooks; fall back to the server's own. |
| `model` | server default | Model override for this channel. |
| `channelHint` | `"Channel: Matrix."` | Extra system-prompt section describing the delivery channel. |
| `personaResolver` | none | Per-sender prompt layer; receives the `mx:<user id>` sender key. |
| `history` | off | `{ store, limit?, historyEnabledFor? }` — any [`HistoryStore`](./history.md). Single-turn until set; `historyEnabledFor` opts specific senders out — see "Privacy controls" in [history.md](./history.md). |
| `muteRegex` / `unmuteRegex` | none | Group mute switch. Inert unless set — this package ships no bot personality. |
| `muteReply` / `unmuteReply` | none | Acknowledgements. Unset = silent. |
| `dmRateLimit` / `groupRateLimit` | 20/h, 30/h | Sliding-window reply budgets, per room. |
| `autoJoin` | `true` | Auto-accept room invites so the bot can actually receive messages in a room it was just invited to. |
| `syncTimeoutMs` | `30000` | How long the homeserver holds an idle `/sync` open. |
| `initialSince` / `onSince` | none | `/sync` token resume point and observer — see [below](#sync-tokens-and-restarts). |
| `fetch` | `globalThis.fetch` | For a proxy, or for tests. |
| `logger` | `deps.logger` | Sync/gate diagnostics. |

A fuller wiring:

```ts
import { createTursoHistoryStore } from "@diegoaltoworks/chatter/history";

const matrix = createMatrixChannel({
  homeserverUrl: process.env.MATRIX_HOMESERVER_URL as string,
  accessToken: process.env.MATRIX_ACCESS_TOKEN as string,
  allowedChats: (process.env.MATRIX_ROOMS ?? "").split(",").filter(Boolean),
  channelHint: "Replies are delivered over Matrix; keep them short.",
  muteRegex: /^!mute$/i,
  unmuteRegex: /^!unmute$/i,
  muteReply: "Muted. Send !unmute to turn me back on.",
  unmuteReply: "I'm back.",
});
```

Conversation history is off by default — the channel stays single-turn until
you give it a store. Any [`HistoryStore`](./history.md) will do; the built-in
one needs a libsql client, which you can create yourself before the server:

```ts
import { createClient } from "@libsql/client";
import { createTursoHistoryStore } from "@diegoaltoworks/chatter/history";

const db = createClient({ url: process.env.TURSO_URL!, authToken: process.env.TURSO_TOKEN });
const matrix = createMatrixChannel({
  homeserverUrl: process.env.MATRIX_HOMESERVER_URL as string,
  accessToken: process.env.MATRIX_ACCESS_TOKEN as string,
  history: { store: createTursoHistoryStore(db, "matrix_history"), limit: 20 },
});
```

History is keyed by room id, so a group shares one thread and each DM has its
own.

## Direct messages vs. groups

Matrix has no per-room "this is a DM" flag the way Telegram's `chat.type`
does. This channel reads the account-data `m.direct` mapping the inviting
client set — every homeserver-standard client maintains it — to tell a DM
room from a group. A room absent from that mapping is treated as a group,
the safer default when a client never populated it for some reason (an
unaddressed message there is ignored rather than answered as if it were
private).

## Group behaviour

Identical policy to the [WhatsApp](./channels.md) and
[Telegram](./telegram.md) channels, because all three run the same gates:

- **DMs always answer.**
- **Groups answer only when addressed** — an intentional mention
  (`content["m.mentions"].user_ids`, the mechanism every current Matrix
  client sets, with a matrix.to pill in `formatted_body` as a fallback for a
  client that only renders one) or a reply to one of the bot's own messages.
  The bot's name in prose is not an invitation.
- **`allowedChats`, when set, wins over everything.** A group not on the
  list is skipped, and its room id is logged once — Matrix room ids
  (`!opaque:server.tld`) are not something you can guess in advance; that log
  line is how you learn what to add.
- **Mute/unmute apply to groups only**, and only when you configure the
  patterns.

Answers are threaded onto the message that prompted them
(`m.relates_to`/`m.in_reply_to`), so a busy room can tell what the bot is
answering. Mute/unmute acknowledgements are sent unthreaded. Reply-to-bot
detection works by remembering this session's own recently-sent event ids
(bounded to the last 500) rather than fetching the replied-to event from the
server — Matrix has no cheap "who sent event X" lookup, and a bot only ever
needs to recognise its own messages, which it already knows without asking.

## Sending without an incoming message

The channel registers a `ChannelSender` under its name, so a scheduler, a
flow or any brain-side feature can send by name without importing anything
Matrix-specific:

```ts
await deps.senders.sendText("matrix", roomId, "Your table is booked.");
await deps.senders.sendMedia("matrix", roomId, { kind: "image", url, caption: "here you go" });
await deps.senders.sendReaction("matrix", roomId, messageRef, "👍");
```

`sendMedia` accepts an `mxc://` content URI (sent as-is) or an https URL
(fetched, then uploaded to the homeserver's media repository), as
`{ kind?: "image" | "file" | "video" | "audio", url, caption?, filename? }` (a
bare string is shorthand for an image). `messageRef` for `sendReaction` is
the Matrix event id, which the channel puts on every `ChannelMessage`.

Every send degrades to `false` rather than throwing when the channel is
stopped or the API call fails — see
[Server Setup](./server.md#sending-without-a-transport).

## Sync tokens and restarts

`start()` resolves the bot's own identity (`whoami`) and then long-polls
`/sync` in the background; `stop()` flips a flag the loop checks between
requests — unlike the Telegram long poll there is no in-flight request to
abort, so the current `/sync` call (already waiting on the homeserver) is
left to return on its own `syncTimeoutMs`.

- **Failures back off exponentially** (2s, 4s, 8s ... capped at a minute),
  and an `M_LIMIT_EXCEEDED` rate-limit response's own `retry_after_ms` is
  honoured verbatim. There is no tight retry loop, ever.
- **A bad token fails `start()`** rather than syncing forever against a
  token that will never work. `createServer` logs and isolates that, so the
  rest of the server still boots.
- **One bad batch never wedges the loop**: the `since` token advances before
  the batch is handled, so a batch whose handling throws is logged and
  skipped rather than reprocessed forever.
- **A limited timeline is not a gap to backfill.** When a room has more
  activity than fits in one `/sync` response, the homeserver marks its
  timeline `limited` and only sends the tail. This channel only cares about
  live traffic — it processes exactly what it's given and never triggers a
  backfill, so a burst of history is simply not replayed, which is the
  behaviour you want for a bot rather than a client trying to render a full
  room history.

**Sync tokens.** Unlike Telegram's offsets, there's no server-side queue to
resume from without one: an initial sync with no `since` token returns the
homeserver's current state, not a backlog. Two knobs if you want continuity
across restarts:

```ts
createMatrixChannel({
  homeserverUrl,
  accessToken,
  onSince: (since) => void saveToken(since), // persist wherever you like
  initialSince: await loadToken(),           // resume from it on boot
});
```

Without `initialSince`, a restart starts from "now" — nothing that happened
while the process was down is replayed. That's usually what you want.

**Only one syncing session per access token, in practice.** Nothing in the
API forbids two concurrent `/sync` loops on the same token, but each `since`
token is independent — two callers polling the same token race each other's
view of `next_batch` and can each answer the same message. Run one instance
of this channel per bot access token.

## Testing your wiring

Nothing here needs a real homeserver: `createMatrixChannel` takes an `api` (or
a `fetch`) override, and `src/channels/matrix/*.test.ts` drives the full
inbound path against a fake client-server API — mention gating, mute/unmute,
allowlists, invite auto-join, direct-message detection, and the sender
registry. Copy that shape for your own tests rather than pointing a test at a
live homeserver.

## Related

- [Building a Channel](./build-a-channel.md) — the SPI this implements
- [WhatsApp Channel](./channels.md) · [Telegram Channel](./telegram.md) — the
  other built-in transports
- [Server Setup](./server.md#channels) — where `channels: []` is configured
- [Conversation History](./history.md) · [Personas](./personas.md) ·
  [Packaging](./packaging.md)
