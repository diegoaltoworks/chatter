# Building a Channel

A **channel** plugs a transport (WhatsApp, Telegram, Matrix, SMS, ...) into a
chatter server through the `Channel` SPI (see
[Server Setup](./server.md#channels)). The built-in
[WhatsApp](./channels.md), [Telegram](./telegram.md) and [Matrix](./matrix.md)
channels are three implementations; this doc is the other half - everything a
channel needs from `./channels` to answer a message, worked through Telegram
so nothing here is WhatsApp-specific by accident.

The Telegram walkthrough below is deliberately a *sketch*: it is the shortest
thing that works, not the shipped channel. The real one lives in
`src/channels/telegram/` and adds what a sketch skips - long-poll backoff,
message splitting, allowlist logging, token redaction, and a second transport
(a webhook route, alongside the long poll) sharing the same update-handling
logic. Read this for the SPI, read that for the precedent.

```ts
import { createInboundPipeline } from "@diegoaltoworks/chatter/channels";
```

## What a transport owns vs. what `./channels` gives you

A transport is responsible for exactly three things:

1. **Turning its own wire format into a `ChannelMessage`.** Every channel
   resolves the same shape - chat id, sender id, text, whether it's a DM,
   whether the bot was addressed, whether the bot sent it itself:

   ```ts
   interface ChannelMessage {
     chatId: string;
     senderId: string;
     text: string;
     isDirectMessage: boolean;
     mentionsBot: boolean;
     isReplyToBot: boolean;
     fromBot: boolean;
     messageRef?: unknown; // opaque per-message handle, if the wire format has one
   }
   ```

   `messageRef` is optional and transport-defined - set it when the wire
   format has a stable handle for "this exact message" (WhatsApp's is the
   Baileys message key) so a caller can later target it, e.g. via
   `ChannelSenderRegistry.sendReaction(name, chatId, messageRef, emoji)`. A
   transport with nothing to put there just omits it.

2. **Delivering a reply through an `InboundReplySender`** - two methods, one
   for the eventual chat answer and one for a mute/unmute acknowledgement.
   Splitting them lets a transport that supports reply-threading (Telegram's
   `reply_to_message_id`, WhatsApp's `quoted`) use it only for the answer,
   while a gate ack stays a plain message:

   ```ts
   interface InboundReplySender {
     sendAnswer(chatId: string, text: string): Promise<void>;
     sendGateReply(chatId: string, text: string): Promise<void>;
   }
   ```

3. **Anything transport-specific that has to run before the normal chat
   turn** - an image request, a slash command, a payment callback - via the
   pipeline's optional `intercept` hook (below).

Everything else - the allowlist/mute/mention gate, DM/group rate limits,
persona resolution, retrieval bucket scoping, loading and appending
conversation history, and the `prepareChat`/`answerOnce` call itself - is
`createInboundPipeline`. It is the exact code the WhatsApp channel runs
after it has built a `ChannelMessage`, extracted once so a second channel
never re-derives it.

Each `handle(msg, turn)` call resolves to an `InboundPipelineOutcome` -
`{ action: "reply", content }` when an answer was actually delivered, or
`{ action: "ignore" | "mute" | "unmute" | "rate-limited" | "intercepted" }`
otherwise (an empty answer from `answerFn` reports `"ignore"`, not
`"reply"`, since nothing was sent). Nothing in the Telegram example below
needs it, but it's there for a channel that wants to log outcomes or drive
a typing indicator only while a reply is actually in flight.

## Wiring it up: a Telegram channel

Telegram's Bot API delivers updates as `{ update_id, message: { chat, from,
text, entities, reply_to_message } }`, over long polling or a webhook - the
transport detail chatter doesn't care about. Assume a small `TelegramClient`
wrapper (`getUpdates`/`sendMessage`, however you fetch it) and build the
`Channel`:

```ts
import type { BrainHooks } from "@diegoaltoworks/chatter";
import type { Channel, ChannelMessage } from "@diegoaltoworks/chatter/channels";
import { createInboundPipeline, resolveBrainHooks } from "@diegoaltoworks/chatter/channels";

interface TelegramUpdate {
  message?: {
    chat: { id: number; type: "private" | "group" | "supergroup" };
    from: { id: number; username?: string };
    text?: string;
    entities?: Array<{ type: string; offset: number; length: number }>;
    reply_to_message?: { from?: { id: number } };
  };
}

export function createTelegramChannel(
  config: BrainHooks & { botToken: string; allowedChats?: string[]; channelHint?: string },
): Channel {
  return {
    name: "telegram",
    async start(deps) {
      const client = new TelegramClient(config.botToken); // your own thin wrapper
      const me = await client.getMe(); // { id, username }

      // Created ONCE per channel start, not per update: gates, mute state
      // and rate limiters live in its closure exactly like a hand-rolled
      // handler's would.
      const handle = createInboundPipeline(
        { client: deps.client, store: deps.store, prompts: deps.prompts },
        {
          channel: "telegram",
          // config's own hook wins; falls back to the server-level one on
          // deps.config for whichever field this channel didn't set.
          ...resolveBrainHooks(config, deps.config),
          channelHint: config.channelHint ?? "Channel: Telegram.",
          allowedChats: config.allowedChats,
          muteRegex: /^\/mute$/i,
          unmuteRegex: /^\/unmute$/i,
          muteReply: "Muted. Send /unmute to turn me back on.",
          unmuteReply: "I'm back.",
        },
      );

      const sender = {
        sendText: (chatId: string, text: string) => client.sendMessage(chatId, text),
      };
      deps.senders.register("telegram", sender);

      client.onUpdate(async (update: TelegramUpdate) => {
        const raw = update.message;
        if (!raw?.text) return; // photos/stickers/etc. are a future intercept, not a gate change

        const text = raw.text;
        const chatId = String(raw.chat.id);
        const mentioned = (raw.entities ?? []).some(
          (e) => e.type === "mention" && text.slice(e.offset, e.offset + e.length) === `@${me.username}`,
        );

        const msg: ChannelMessage = {
          chatId,
          senderId: String(raw.from.id),
          text,
          isDirectMessage: raw.chat.type === "private",
          mentionsBot: mentioned,
          isReplyToBot: raw.reply_to_message?.from?.id === me.id,
          // One identity only - see "Loop guards across multiple bot
          // identities" below for what a real channel does here.
          fromBot: raw.from.id === me.id,
        };

        try {
          await handle(msg, {
            reply: {
              sendAnswer: (id, text) => client.sendMessage(id, text, { replyToLastMessage: true }),
              sendGateReply: (id, text) => client.sendMessage(id, text),
            },
            sender: `tg:${raw.from.id}`,
            conversationId: chatId,
          });
        } catch (error) {
          console.warn(`Telegram: inbound message handling failed:`, error);
        }
      });
    },
  };
}
```

```ts
await createServer({ ..., channels: [createTelegramChannel({ botToken: process.env.TG_TOKEN! })] });
```

Walking through what each piece is doing:

- **One pipeline per channel start, one `handle()` call per message.**
  `createInboundPipeline`'s gates, mute-state `Set`, and rate limiters are
  stateful and live in its closure - build it once in `start()`, not inside
  the update handler.
- **`ChannelMessage` construction is the transport's whole job.** Telegram
  has no separate "own mention" stripping step the way WhatsApp does (bot
  usernames arrive as ordinary `@mention` entities a model can already
  read), so there's nothing to clean here - a channel with WhatsApp's
  problem would strip it the same way, before building `msg.text`.
- **The reply object is built fresh per message** (not stored in config)
  because the answer needs to thread onto *this* incoming message -
  `reply_to_message_id`/`quoted` is per-reply state, not per-channel state.
- **`sender` is per-call, not per-channel**, because it identifies who's
  talking, not who's listening. Pass a plain string when it's already
  known; pass a thunk (`() => Promise<string>`) when resolving it takes
  work (an API call, a lookup) so the pipeline only pays for it once gates
  and rate limits have already let the message through - exactly what the
  WhatsApp channel does to resolve a LID identity to a phone number.
- **Outbound-without-a-transport** (a scheduler, a flow) is a separate
  concern from inbound: register a plain `ChannelSender` (`sendText`) into
  `deps.senders` so brain-side features can send by channel name without
  knowing this is Telegram - see [Server Setup](./server.md#sending-without-a-transport).

## The `intercept` hook

`InboundTurn.intercept` runs after gates and rate-limiting pass, before
persona/buckets/history/`answerOnce` - for a feature that fully owns the
reply for the messages it claims (WhatsApp's image-request routing is the
shipped example: `./channels/whatsapp/images.ts`). Returning `true` stops
the turn there; `false`/`undefined` falls through to the normal chat
answer:

```ts
await handle(msg, {
  reply,
  intercept: async (sender) => {
    if (!isDrawRequest(msg.text)) return false;
    await generateAndSendImage(msg.chatId, msg.text, sender);
    return true;
  },
});
```

It receives the resolved `sender` (already awaited if you passed a thunk),
so an intercepted feature never has to re-resolve identity itself.

## Conversation history

Pass `history: { store, limit?, historyEnabledFor? }` (any `HistoryStore` -
see [history.md](./history.md)) to load prior turns ahead of the new message
and append both turns after. Off by default, so a new channel starts
single-turn exactly like WhatsApp did before it opted in. `historyEnabledFor`
excludes specific senders from memory entirely - see "Privacy controls" in
[history.md](./history.md).

```ts
import { createTursoHistoryStore } from "@diegoaltoworks/chatter/history";

const handle = createInboundPipeline(deps, {
  ...,
  history: { store: createTursoHistoryStore(deps.db, "telegram_history"), limit: 20 },
});
```

History is keyed by `conversationId` (defaulting to `msg.chatId`) - pass an
explicit one per call if a channel's thread identity differs from its chat
id.

## Observability: a rejected group is easy to miss

A group chat id isn't guessable in advance, so if you use `allowedChats`,
log it the same way WhatsApp does - `isBlockedByAllowlist` (also exported
from `./channels`) is the exact predicate the pipeline uses internally, so
calling it yourself on the same `ChannelMessage` tells you precisely when
that's the reason a message was dropped:

```ts
import { isBlockedByAllowlist } from "@diegoaltoworks/chatter/channels";

if (isBlockedByAllowlist(msg, { allowedChats: config.allowedChats ?? [] })) {
  console.log(`Telegram: skipped group ${msg.chatId} - not in allowedChats`);
}
```

Dedup this yourself if a chatty non-allowlisted group could flood your logs
- the WhatsApp channel keeps a small `Set` of chat ids it has already
logged, for exactly that reason.

## Loop guards across multiple bot identities

Register what your channel answers to as soon as you know it, and resolve
`fromBot` through `isEffectivelyFromSelf` from `./channels` rather than
against your own identity alone:

```ts
// In start(deps), once the transport has told you who you are:
deps.identities.set(channelName, [String(me.id)]);

// Per message:
fromBot: isEffectivelyFromSelf(
  { fromBot: raw.from.id === me.id, senderId: String(raw.from.id) },
  deps.identities,
),
```

The plain equality check the sketch above uses is only right for a process
running one identity. Your transport does not have to be the one running
several: a second bot token, a second Matrix account or a second linked
WhatsApp number mounted alongside yours is a stranger to your `me`, so you
answer it, it answers you, and the two burn model budget on each other until
someone notices.

`deps.identities` is the registry `createServer` shares with every channel
(see [docs/channels.md](channels.md#loop-protection-across-identities)). Key
your entry by something unique across the whole server - your channel name
does that, and the WhatsApp handler's session ids share the same key space -
re-register whenever your identity changes, and never delete an entry when an
endpoint disconnects: it is still "us" while it reconnects.

## From sketch to shipped channel

`./telegram` is the same shape as the code above, with the parts a real
deployment needs. If you are building a third transport, these are the
questions the sketch does not answer for you - each with where the shipped
channel answers it:

| Concern | Where `./telegram` handles it |
| --- | --- |
| A remote API that is down, or rate-limiting | `poll.ts` - exponential backoff, plus Telegram's own `retry_after` |
| One update whose handling throws | `poll.ts` - offset advances first, so a poison message can't repeat forever |
| Credentials in error text | `api.ts` - `redactToken` before anything is logged |
| A transport message-size limit | `api.ts` - `splitTelegramText` at 4096 chars, threading the first chunk only |
| Shutdown while a request is in flight | `channel.ts` - an `AbortController` cuts the long poll in `stop()`, and the acknowledged offset does not advance past a batch the loop will no longer handle (`./matrix` does both for `/sync` too) |
| Joining a room on someone else's say-so | `handler.ts` - an invite is an unauthenticated request from any user, so `./matrix` gates auto-join by the same `allowedChats` that gates replies |
| Sender identity that isn't a phone number | `updates.ts` - a namespaced `tg:<id>` key, never a bare numeral |
| A non-allowlisted group nobody can see | `handler.ts` - `isBlockedByAllowlist`, logged once per chat |
| A second way to receive updates, without duplicating the logic above | `handler.ts` - the same update handler feeds both `channel.ts`'s long poll and `webhook.ts`'s `customRoutes` mount |

Its tests (`src/channels/telegram/*.test.ts`) drive the full inbound path
against a fake Bot API - no network, no token - which is also the pattern to
copy for your own.

## What you get for free

Everything routed through `createInboundPipeline` automatically honours a
configured `answerFn`, `bucketsFor`, `rewriteQuery`, `rerankContext`,
`fallbackFn` and `transformReply` (the same seams every other chatter
surface uses - see [integrations.md](./integrations.md)), applies output
guardrails, and answers through `prepareChat`, so a new channel never
hand-rolls its own prompt assembly or drifts from the model/config the rest
of the server uses.

## Conformance

`test/channel-conformance.test.ts` runs the same scenario list once per
built-in channel, against a fake wire the same way each channel's own
`*.test.ts` already does - see that file for the current scenario list.
Drift in any single channel's wiring (an unpassed hook, a hardcoded default,
a gate applied out of order) fails that channel's own run of the shared
scenario without the others needing to change. A new transport plugs into
the suite by adding an adapter there - `deliver()` (send one addressed
message, report what happened) and `senderLifecycle()` (start, confirm
registration, stop, confirm it's gone) are the whole contract.
