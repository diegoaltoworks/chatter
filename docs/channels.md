# WhatsApp Channel

A built-in transport that links a WhatsApp number as a linked device and
plugs it into a chatter server through the `Channel` SPI documented in
[Server Setup](./server.md#channels). Published as its own subpath so the
core install is unaffected by it:

```ts
import { createWhatsAppChannel } from "@diegoaltoworks/chatter/whatsapp";
```

> **ToS warning.** This channel is built on
> [Baileys](https://github.com/WhiskeySockets/Baileys), an unofficial
> WhatsApp client. Linking a number this way carries a real risk of that
> number being banned by WhatsApp. Use a number you can afford to lose, and
> treat this channel as opt-in — never wire it up by default.

Baileys is an **optional peer dependency**: `bun install`, every core import,
and `bun run check` all work without it. Install it only when you actually
use this channel:

```bash
bun add @whiskeysockets/baileys
```

Importing `./whatsapp` itself never touches Baileys — only `channel.start()`
resolves it, and does so eagerly (before any session connects) so a missing
package fails that channel's start with an actionable error naming it,
rather than a raw module-resolution failure or a retry loop that never
surfaces the problem.

## Configuring the channel

```ts
import { createWhatsAppChannel } from "@diegoaltoworks/chatter/whatsapp";

const whatsapp = createWhatsAppChannel({
  sessionSecret: process.env.WA_SESSION_SECRET as string,
  sessionIds: (process.env.WA_SESSION_IDS ?? "default").split(","),
  onMessage: async ({ sessionId, sock, message }) => {
    // Interpret the raw Baileys message and decide how to respond. Pair this
    // with `./channels`' decideChannelAction, isEffectivelyFromSelf, and the
    // reply-decision gates — this channel does no interpretation of its own.
    // `createWhatsAppInboundHandler` (below) is the built-in implementation
    // of this callback.
  },
});

await createServer({ ..., channels: [whatsapp] });
```

- **`sessionSecret`** (required, at least 16 characters — a shorter or empty
  value throws at channel creation) encrypts the stored session at rest
  (AES-256-GCM, key derived via scrypt with a fresh salt per row). Keep it
  stable across restarts and deploys — losing it means every linked session
  must be re-paired. Generate one with, e.g., `openssl rand -base64 32`.
- **`sessionIds`** — one Baileys connection per id, each a separate WhatsApp
  number. Defaults to `["default"]`. The `"default"` session's stored rows
  are unprefixed, so a single-number deployment introduced before
  multi-session support needs no migration.
- **`onMessage`** receives every raw inbound message on every session. A
  throwing or rejecting handler is caught and logged — it never crashes the
  socket's event loop.

## Answering messages

`createWhatsAppInboundHandler` is the built-in `onMessage` implementation:
it turns a raw Baileys message into a `ChannelMessage` (mentions, loop guard,
own-mention stripping — everything Baileys-shaped), then hands it to
`./channels`' `createInboundPipeline`, which applies `decideChannelAction`
(allowlist, mute/unmute, DM/group rate limits) and answers through the same
`prepareChat`/`answerOnce` seam every other surface uses — so the WhatsApp
channel automatically honours a configured `answerFn`, `bucketsFor`,
`rewriteQuery`, `rerankContext` and `transformReply`. See
[Building a Channel](./build-a-channel.md) for how to put the same pipeline
behind a different transport.

It needs the same `client`/`store`/`prompts` `createServer` builds into
`ServerDependencies`, which only exist once `createServer` runs — after the
`channels` array (and therefore `onMessage`) must already be configured.
Wire it up from `customRoutes`, which receives the same deps and runs
before channels start:

```ts
import {
  createWhatsAppChannel,
  createWhatsAppInboundHandler,
  type WhatsAppMessageEvent,
} from "@diegoaltoworks/chatter/whatsapp";

let handleInbound: ((event: WhatsAppMessageEvent) => Promise<void>) | undefined;

const whatsapp = createWhatsAppChannel({
  sessionSecret: process.env.WA_SESSION_SECRET as string,
  onMessage: (event) => handleInbound?.(event),
});

await createServer({
  ...,
  channels: [whatsapp],
  customRoutes: async (app, deps) => {
    handleInbound = createWhatsAppInboundHandler({
      client: deps.client,
      store: deps.store,
      prompts: deps.prompts,
      answerFn: deps.config.answerFn,
      bucketsFor: deps.config.bucketsFor,
      rewriteQuery: deps.config.rewriteQuery,
      rerankContext: deps.config.rerankContext,
      transformReply: deps.config.transformReply,
      logger: deps.logger,
      // Share ONE registry across every WhatsApp channel instance in this
      // process — it's how the loop guard recognises another linked
      // number's own traffic as "us" rather than a stranger.
      registry: new Map(),
      allowedChats: (process.env.WA_CHAT_ALLOWLIST ?? "").split(",").filter(Boolean),
      channelHint: "Channel: WhatsApp.",
    });
  },
});
```

Configuration:

- **`registry`** — a `SessionIdentityRegistry` (see `./channels`), shared
  across every session this handler serves. Populated automatically from
  each message's `sock.user`; never cleared, so a reconnecting session is
  still recognised as itself.
- **`allowedChats`** — group chats eligible for a reply. Empty (default) =
  every group; has no effect on DMs, which always reply. A group jid isn't
  guessable in advance: when a group is rejected by this gate, its jid is
  logged once (`WhatsApp[<sessionId>]: skipped group <jid> - not in
  allowedChats`) so you can copy it in.
- **`muteRegex`/`unmuteRegex`** and **`muteReply`/`unmuteReply`** — no
  defaults are shipped (this module carries no bot personality); an unset
  reply string means the mute/unmute state still flips, silently.
- **`dmRateLimit`/`groupRateLimit`** — `{ max, windowMs }` sliding-window
  budgets, each with a generous per-hour default (see
  `WhatsAppInboundConfig`) — tune for your own traffic.
- **`personaResolver`**  — optional `({ senderPhone, text }) => string |
  undefined`, plugged into `prepareChat`'s `personaLayer`. The resolution
  mechanism (a contact registry, windowed probability rolls, ...) is a
  separate concern; this only wires the result through. A throwing/rejecting
  resolver degrades to no persona for that turn rather than failing the
  reply.
- **`channelHint`** — passed straight through to `prepareChat`.

### Mentions in the message text

WhatsApp writes an @mention into the raw text as the literal token
`@<digits>` — the mentioned jid's number — and only resolves it to a jid on
`contextInfo`. The handler removes the bot's *own* mention tokens before the
text reaches the gates, image routing or the model (`stripOwnMentions`, also
exported from `./whatsapp` for hosts writing their own `onMessage`), so a
group message addressed to the bot arrives as the sentence a human would read
rather than as a bare number the model has to guess at. Other participants'
mentions are left as-is: those are real context, and the rest of the message
is untouched down to its indentation.

Two consequences worth knowing when you configure the handler:

- `muteRegex`/`unmuteRegex` are matched against the cleaned text, so an
  anchored pattern like `/^go quiet$/i` still fires on a mention-prefixed
  command.
- A mention-only message (`@bot` and nothing else) keeps its original text.
  Emptying it would make the reply gates read it as blank and drop it, and
  going silent on being addressed is the worse failure.

## Image requests

`createWhatsAppImageHandler` (see `./whatsapp`) plugs `./images` into the
channel: it detects a drawing/picture request — with or without an attached
photo — and replies with the generated image. It's inert unless `./images`
is configured, so wiring it up is safe even before you've set up an image
provider:

```ts
import { createWhatsAppImageHandler, loadBaileys } from "@diegoaltoworks/chatter/whatsapp";

handleInbound = createWhatsAppInboundHandler({
  ...,
  images: createWhatsAppImageHandler({
    images: imageUploader, // from `./images`'s createImageUploader
    checkAndReserve: (senderId) => dailyImageLimiter.checkAndReserve(senderId),
    downloadPhoto: async (message) => {
      const baileys = await loadBaileys();
      return new Uint8Array((await baileys.downloadMediaMessage(message, "buffer", {})) as Buffer);
    },
    strings: {
      ack: "Working on it!",
      limitReached: "That's enough images for today — try again tomorrow.",
      moderationBlocked: "I can't draw that one.",
      error: "Something went wrong generating that image.",
    },
  }),
});
```

- **`images`** (required) — the slice of an `ImageUploader` this module
  needs: `isConfigured`, `peekCached`, `getOrCreateImage`.
- **`checkAndReserve`** — an optional per-sender/day cap (e.g. `./usage`'s
  `DailyLimiter.checkAndReserve`). Checked only on a cache miss, so a
  repeated request never burns a unit of quota.
- **`downloadPhoto`** — resolves the attached photo's bytes when a request
  arrives with one, so the image module can composite against it. Wire it
  through `loadBaileys` yourself, as shown above — `images.ts` never
  imports Baileys, matching the rule that only `./baileys` touches the
  optional peer dependency at runtime.
- **`strings`** — no defaults are shipped for any outcome (ack, cap
  reached, moderation-blocked, generic error); an unset string means that
  outcome replies silently.

## Conversation history

By default the handler is single-turn: only the latest message reaches
`prepareChat`/`answerOnce`. Configure `history` (see
[history.md](./history.md)) to load prior turns for the chat before answering
and append the new turn after — off by default, so existing deployments are
unaffected:

```ts
import { createTursoHistoryStore } from "@diegoaltoworks/chatter/history";

handleInbound = createWhatsAppInboundHandler({
  ...,
  history: {
    store: createTursoHistoryStore(deps.db, "whatsapp_history"),
    limit: 20, // turns loaded per reply; default 20
  },
});
```

- **`store`** — any `HistoryStore`; the shipped Turso implementation is keyed
  by `deps.db`, the same handle chatter already opened for retrieval.
- **`limit`** — most recent turns loaded per reply. This bounds what one
  `load` returns; the store itself also prunes what it physically keeps (see
  `createTursoHistoryStore`'s `maxPerConversation`). Every loaded turn is a
  full message on every reply's prompt, so raising it raises token cost too —
  see [history.md](./history.md).
- **`historyEnabledFor`** — excludes a sender from memory entirely; see
  "Privacy controls" in [history.md](./history.md) for this, retention TTLs,
  and the `clear` reset primitive.
- **`compaction`** — folds older turns into a stored summary once a
  conversation's turn count reaches a threshold, so `limit`/`load` keep
  returning a bounded window without growing the prompt forever; see
  "Compaction" in [history.md](./history.md). Off by default.

History is keyed by chat jid, so a group chat's history is shared across every
participant in it — there is no per-sender history within a group. A message
the image handler (`./images`, above) intercepts never reaches this store —
only turns answered through the normal chat pipeline are recorded.

The detector and subject-cleaner (which strips mention tokens, greetings,
and the draw verb itself to derive the picture's subject) default to a
generic set of drawing verbs with no bot-specific names; override both via
`detector: { detectPattern, stripPatterns }` if your host needs different
triggers.

## Multiple detectors

A host sometimes needs more than one thing to happen on an inbound message:
react to a voice note, fire a fixed acknowledgement alongside the normal
reply, or let a different handler fully replace the answer for messages
matching some pattern. Hand-rolling that on top of `onMessage` means
re-deriving own-identity resolution, the loop guard, and the allowlist/mute
wiring per handler — and nothing stops a handler meant to run *alongside*
the reply from being wired with the *replaces the reply* convention instead,
silently eating the real answer.

`createWhatsAppMessageRouter` (see `./whatsapp`) resolves identity and
gating once per message, then fans it out to any number of `detectors`:

```ts
import {
  createWhatsAppChannel,
  createWhatsAppInboundHandler,
  createWhatsAppMessageRouter,
} from "@diegoaltoworks/chatter/whatsapp";
import type { SessionIdentityRegistry } from "@diegoaltoworks/chatter/channels";

const registry: SessionIdentityRegistry = new Map();

const router = createWhatsAppMessageRouter({
  registry,
  allowedChats: (process.env.WA_CHAT_ALLOWLIST ?? "").split(",").filter(Boolean),
  detectors: [
    // Fires independently of the reply — never blocks it, never treated as
    // "handled" even if it throws.
    {
      name: "voice-note-trigger",
      mode: "parallel",
      test: (ctx) => Boolean(ctx.message.message?.audioMessage),
      handle: async (ctx) => {
        await transcribeAndLog(ctx.sock, ctx.message);
      },
    },
    {
      name: "fixed-reaction",
      mode: "parallel",
      test: (ctx) => /^lol\b/i.test(ctx.text),
      handle: async (ctx) => {
        await ctx.react("😂");
      },
    },
    // Checked in registration order; the first match fully owns the message
    // and the fallback below never runs for it.
    {
      name: "extraction-reply",
      mode: "replace",
      test: (ctx) => looksLikeExtractionRequest(ctx.text),
      handle: async (ctx) => {
        const result = await runExtraction(ctx.text);
        await ctx.sock.sendMessage(ctx.msg.chatId, { text: result });
      },
    },
  ],
  // An existing single-handler host plugs in unchanged as the fallback.
  fallback: createWhatsAppInboundHandler({
    client: deps.client,
    store: deps.store,
    prompts: deps.prompts,
    registry,
  }),
});

const whatsapp = createWhatsAppChannel({
  sessionSecret: process.env.WA_SESSION_SECRET as string,
  onMessage: (event) => router(event),
});
```

- **`"parallel"` detectors** all fire for a matching message, without
  awaiting or gating the reply path; a throwing/rejecting `handle` is caught
  and logged (or passed to `onDetectorError`, if set) and never blocks
  another detector or the fallback.
- **`"replace"` detectors** run in registration order; the first whose
  `test` matches has its `handle` awaited and the fallback is skipped
  entirely. No match runs `fallback` instead.
- **`ctx`** (`WaDetectorContext`) bundles the already-resolved
  `ChannelMessage`, own identities, and the already-extracted,
  own-mention-stripped text, alongside the raw `sock`/`message` a detector
  needs to actually reply — no detector re-derives mention/loop-guard
  resolution itself.
- **`ctx.react(emoji)`** sends a Baileys reaction to the current message
  without a detector re-deriving the targeting itself. Because `ctx` only
  ever exists for a message that already cleared the loop guard and
  `allowedChats` (see below), a reaction can never fire where those same
  checks would have gated a reply. A failed send is caught and logged, the
  same as a detector error — it never throws and never affects the reply
  path.
- The loop guard and `allowedChats` are enforced once, before any detector
  runs — a message from the bot's own session, or from a group the whole
  channel isn't eligible for, never reaches a detector or the fallback.
- **`fallback`** is typed identically to `onMessage`/`createWhatsAppInboundHandler`'s
  return, so an existing single-handler host becomes the fallback with no
  adaptation, exactly as shown above.

The router is additive: a host with a single `createWhatsAppInboundHandler`
call and no interceptors of its own has no reason to introduce it.

## Auth state

Session material (which grants full account access) is stored encrypted in
the same database connection the rest of chatter uses — `deps.db` — under a
`wa_auth` table, created on first use. No second database connection is
opened.

## Pairing

Link a number with the bundled CLI, which reads `TURSO_URL`,
`TURSO_AUTH_TOKEN`, and `WA_SESSION_SECRET` from the environment:

```bash
# QR mode — scan with WhatsApp -> Settings -> Linked Devices -> Link a Device
bun run wa-pair [sessionId]

# Pairing-code mode — for headless setups with no terminal to scan from
bun run wa-pair [sessionId] --code 447700900123

# Wipe a stored session and pair fresh
bun run wa-pair [sessionId] --reset
```

QR mode additionally needs the optional peer dependency `qrcode-terminal`
(`bun add qrcode-terminal`); pairing-code mode does not. If the terminal
render is unavailable (dependency missing, or its exports don't match the
runtime's interop shape), `wa-pair` prints the raw QR payload and pairing-code
instructions instead of dead-ending — pairing keeps progressing either way.

Bun's `ws` client can log an `"upgrade"`/`"unexpected-response"` "not
implemented" warning to stderr while a socket negotiates — that's a benign gap
in Bun's WebSocket event coverage, not a pairing failure; ignore it as long as
the CLI keeps printing reconnect/status lines.

Expect the connection to close mid-pairing — WhatsApp always asks for a
restart (status 515) the instant a QR scan registers the device, and bounces
the socket again while a pairing code is being typed. The CLI treats those as
normal: it reconnects with the *stored* session (never a fresh one, which
would show a new QR and leave the phone stuck on "linking") until the
connection reports open, printing each attempt. Only an explicit logout or
running out of attempts ends the run, so one invocation completes a link — no
shell loop around `wa-pair` needed.

Credentials keep being saved across that whole window, and the CLI holds the
open connection until it has **re-read the stored session and seen it marked
registered** — the flag the server looks for when deciding whether a session
is usable often arrives on a final update just after the connection opens.
Success is reported only after that read, so `✅ Paired session ...` means the
server will find the session. If the flag never lands, the CLI says so and
exits non-zero instead of claiming a link that isn't there; run `wa-pair`
again (add `--reset` to pair from scratch).

Pairing a session for the **first time** needs no restart: an unpaired
session re-checks its auth state every 60 seconds, so the running server
picks it up on its next check. Re-pairing **after a logout** (see
Reconnection, below) is different — that session's connection loop already
gave up, so pairing alone does not bring it back; restart (or redeploy) the
server after re-pairing.

## Deploy lease

Rolling deploys can briefly run an outgoing and incoming revision side by
side. WhatsApp treats a second concurrent connection for the same session as
a takeover and logs the first one out, so this channel acquires a lease
(stored in a `wa_lease` table, alongside `wa_auth`) before connecting each
session, and renews it on a heartbeat for as long as it holds the
connection. A revision that loses the race waits and re-checks rather than
connecting; a revision that goes stale (crashed without a clean shutdown)
frees its lease automatically once the stale window passes.

Wire the channel's `stop()` into your shutdown path (see
[Server Setup's Shutdown section](./server.md#shutdown)) so the lease
releases promptly on a graceful deploy rather than waiting out the stale
window:

```ts
const app = await createServer({ ..., channels: [whatsapp] });

process.on("SIGTERM", async () => {
  await app.stopChannels();
  process.exit(0);
});
```

## Reconnection

This applies to an established connection; pairing has its own, much tighter
policy (above), because a human is holding a phone whose link attempt times
out. A closed connection reconnects with exponential backoff (5s, 10s, 20s,
... capped at 10 minutes) — hammering WhatsApp during an outage or a ban
aggravates ban scoring. A session that WhatsApp explicitly logs out does
**not** reconnect — retrying with the same, now-revoked credentials would
just get logged out again on a tight loop, the exact behaviour the backoff
exists to avoid. That session's connection loop exits for good; re-pair it
with `wa-pair` and restart (or redeploy) the server to pick it back up.

## Sending without a transport

Each connected session registers a sender into the
`ChannelSenderRegistry` every channel receives as `deps.senders` (see
[Server Setup](./server.md#sending-without-a-transport)) — the `"default"`
session under the channel's own name (`"whatsapp"`), every other session
under `"whatsapp:<sessionId>"`:

```ts
await deps.senders.sendText("whatsapp", "447700900123@s.whatsapp.net", "hi");
```

The same registry also carries `sendReaction(name, chatId, messageRef, emoji)`
for a channel-agnostic caller that already has a `ChannelMessage` in hand —
`msg.messageRef` is the Baileys message key `resolveWaMessage` attaches, ready
to pass straight through:

```ts
await deps.senders.sendReaction("whatsapp", msg.chatId, msg.messageRef, "👍");
```

Inside a WhatsApp router detector, prefer `ctx.react(emoji)` (above) — it's
already bound to the current message.

## Full example

[`examples/full-bot`](../examples/full-bot/) wires this channel, a persona
registry, gates, images and the scheduler into one config-driven server.
