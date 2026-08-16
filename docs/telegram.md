# Telegram Channel

Run a chatter bot on Telegram's official [Bot API](https://core.telegram.org/bots/api).
It is the second built-in transport on the [Channel SPI](./build-a-channel.md),
and the cheapest one to adopt: the Bot API is JSON over HTTPS, so `./telegram`
adds **no dependency at all** — not even an optional peer.

```ts
import { createServer } from "@diegoaltoworks/chatter/server";
import { createTelegramChannel } from "@diegoaltoworks/chatter/telegram";

await createServer({
  // ...your usual config
  channels: [createTelegramChannel({ botToken: process.env.TELEGRAM_BOT_TOKEN as string })],
});
```

That is the whole minimum. Everything past turning an update into a message —
allowlist/mute gates, reply rate limits, persona resolution, retrieval buckets,
history, the `answerFn` brain hook — is the shared inbound pipeline every
channel runs.

## Getting a bot token

1. Message [@BotFather](https://t.me/BotFather) on Telegram, send `/newbot`,
   pick a name and a username.
2. It replies with a token like `123456789:AA...`. That token **is** the bot —
   keep it in the environment, never in the repo. Chatter never logs it: any
   error text that could contain it is redacted to `***` before it reaches a
   log line.
3. To use the bot in groups, either add it as an admin, or send
   `/setprivacy` → `Disable` to BotFather so it can see unaddressed group
   messages. Leaving privacy mode **on** is fine and is the safer default —
   see [Group behaviour](#group-behaviour) below.

## What a bot can and cannot do

Honest limits of the bot model, none of which chatter can work around:

- **A bot cannot start a conversation.** The user must message it (or add it
  to a group) first. No cold DMs.
- **Privacy mode restricts what it sees in groups.** With privacy on (the
  default), Telegram only delivers messages that address the bot: an @mention,
  a reply to one of its messages, or a `/command@yourbot`. That is exactly the
  policy chatter's own group gate applies anyway, so the two agree.
- **It is visibly a bot.** A "bot" badge, a `/start` button, no presence. If
  you need a bot to look like a person, that is a user-mode client, not this.

## Configuration

| Option | Default | What it does |
| --- | --- | --- |
| `botToken` | *(required)* | From @BotFather. |
| `name` | `"telegram"` | Channel and sender-registry name. Give each bot its own when running several in one process. |
| `allowedChats` | `[]` (all) | Group chat ids eligible for a reply. DMs always reply. |
| `answerFn` / `bucketsFor` / `rewriteQuery` / `rerankContext` / `transformReply` | `deps.config.*` | The brain, retrieval-scope, retrieval-shaping and outbound-reply hooks; fall back to the server's own. |
| `model` | server default | Model override for this channel. |
| `channelHint` | `"Channel: Telegram."` | Extra system-prompt section describing the delivery channel. |
| `personaResolver` | none | Per-sender prompt layer; receives the `tg:<id>` sender key. |
| `history` | off | `{ store, limit? }` — any [`HistoryStore`](./history.md). Single-turn until set. |
| `muteRegex` / `unmuteRegex` | none | Group mute switch. Inert unless set — this package ships no bot personality. |
| `muteReply` / `unmuteReply` | none | Acknowledgements. Unset = silent. |
| `dmRateLimit` / `groupRateLimit` | 20/h, 30/h | Sliding-window reply budgets, per chat. |
| `pollTimeoutSeconds` | `30` | How long Telegram holds an idle `getUpdates` open. |
| `initialOffset` / `onOffset` | none | Update-offset resume point and observer — see [below](#offsets-and-restarts). |
| `apiBaseUrl` | `https://api.telegram.org` | For a self-hosted Bot API server. |
| `fetch` | `globalThis.fetch` | For a proxy, or for tests. |
| `logger` | `deps.logger` | Poll/gate diagnostics. |

A fuller wiring:

```ts
import { createTursoHistoryStore } from "@diegoaltoworks/chatter/history";

const telegram = createTelegramChannel({
  botToken: process.env.TELEGRAM_BOT_TOKEN as string,
  allowedChats: (process.env.TELEGRAM_GROUPS ?? "").split(",").filter(Boolean),
  channelHint: "Replies are delivered over Telegram; keep them short.",
  muteRegex: /^\/mute$/i,
  unmuteRegex: /^\/unmute$/i,
  muteReply: "Muted. Send /unmute to turn me back on.",
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
const telegram = createTelegramChannel({
  botToken: process.env.TELEGRAM_BOT_TOKEN as string,
  history: { store: createTursoHistoryStore(db, "telegram_history"), limit: 20 },
});
```

History is keyed by chat id, so a group shares one thread and each DM has its
own.

## Group behaviour

Identical policy to the [WhatsApp channel](./channels.md), because both run the
same gates:

- **DMs always answer.**
- **Groups answer only when addressed** — an `@yourbot` mention, a
  `/command@yourbot`, or a reply to one of the bot's own messages. The bot's
  name in prose is not an invitation.
- **`allowedChats`, when set, wins over everything.** A group not on the list
  is skipped, and its chat id is logged once (group ids are negative numbers
  you cannot guess in advance — that log line is how you learn what to add).
- **Mute/unmute apply to groups only**, and only when you configure the
  patterns.

Answers are threaded onto the message that prompted them (`reply_parameters`),
so a busy group can tell what the bot is answering. Mute/unmute acknowledgements
are sent unthreaded.

Long answers are split at Telegram's 4096-character limit on whitespace
boundaries; only the first chunk quotes the incoming message. Without that, the
Bot API would reject an over-long answer outright and the reply would be lost.

## Sending without an incoming message

The channel registers a `ChannelSender` under its name, so a scheduler, a flow
or any brain-side feature can send by name without importing anything Telegram:

```ts
await deps.senders.sendText("telegram", chatId, "Your table is booked.");
await deps.senders.sendMedia("telegram", chatId, { kind: "photo", url, caption: "here you go" });
await deps.senders.sendReaction("telegram", chatId, messageRef, "👍");
```

`sendMedia` accepts an https URL or a Telegram `file_id`, as
`{ kind?: "photo" | "document" | "video" | "audio", url, caption? }` (a bare
string is shorthand for a photo URL). `messageRef` for `sendReaction` is the
Telegram `message_id`, which the channel puts on every `ChannelMessage`.

Every send degrades to `false` rather than throwing when the channel is stopped
or the API call fails — see [Server Setup](./server.md#sending-without-a-transport).

## Long polling, offsets and restarts

`start()` resolves the bot's own identity (`getMe`) and then long-polls
`getUpdates` in the background; `stop()` aborts the in-flight poll so shutdown
does not wait out the 30-second hold.

- **Failures back off exponentially** (2s, 4s, 8s ... capped at a minute), and
  a `429` flood-wait from Telegram is honoured verbatim. There is no tight
  retry loop, ever.
- **A bad token fails `start()`** rather than polling forever against a token
  that will never work. `createServer` logs and isolates that, so the rest of
  the server still boots.
- **One bad update never wedges the loop**: the offset advances before the
  update is handled, so a message whose handling throws is logged and skipped
  rather than redelivered forever.

**Offsets.** Telegram itself remembers where you are: requesting `offset = N`
acknowledges everything below `N`, and un-acknowledged updates are retained for
about 24 hours. So a restart with no configuration replays whatever is still
queued — which is what you want after a brief deploy, and can be a burst of
stale messages after a long outage. Two knobs if you care:

```ts
createTelegramChannel({
  botToken,
  onOffset: (offset) => void saveOffset(offset), // persist wherever you like
  initialOffset: await loadOffset(),             // resume from it on boot
});
```

Passing an `initialOffset` past the queue simply discards the backlog — the
straightforward way to say "answer what arrives from now on, not what piled up
while I was down".

**Only one consumer per token.** Telegram rejects a second `getUpdates` for the
same bot with a `409 Conflict`, and a webhook registered for the token
suppresses polling entirely. Run one instance of this channel per bot token —
unlike the WhatsApp channel there is no lease to arbitrate that for you,
because Telegram arbitrates it itself.

## Testing your wiring

Nothing here needs a real bot: the channel takes an `api` (or a `fetch`)
override, and `src/channels/telegram/*.test.ts` drives the full inbound path
against a fake Bot API — mention gating, mute/unmute, allowlists, the sender
registry and the poll loop's backoff. Copy that shape for your own tests rather
than pointing a test at a live token.

## Related

- [Building a Channel](./build-a-channel.md) — the SPI this implements
- [WhatsApp Channel](./channels.md) — the other built-in transport
- [Server Setup](./server.md#channels) — where `channels: []` is configured
- [Conversation History](./history.md) · [Personas](./personas.md) · [Packaging](./packaging.md)
