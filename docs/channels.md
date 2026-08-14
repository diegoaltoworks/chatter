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

- **`sessionSecret`** (required) encrypts the stored session at rest
  (AES-256-GCM). Keep it stable across restarts and deploys — losing it
  means every linked session must be re-paired. Generate one with, e.g.,
  `openssl rand -base64 32` — the key derives from it directly (a single
  SHA-256 pass, no salt or stretching), so a high-entropy value matters more
  here than for a typical human-chosen password.
- **`sessionIds`** — one Baileys connection per id, each a separate WhatsApp
  number. Defaults to `["default"]`. The `"default"` session's stored rows
  are unprefixed, so a single-number deployment introduced before
  multi-session support needs no migration.
- **`onMessage`** receives every raw inbound message on every session. A
  throwing or rejecting handler is caught and logged — it never crashes the
  socket's event loop.

## Answering messages

`createWhatsAppInboundHandler` is the built-in `onMessage` implementation:
it turns a raw Baileys message into a `ChannelMessage`, runs it through
`./channels`' `decideChannelAction` (allowlist, mute/unmute, DM/group rate
limits) and cross-session loop guard, then answers through the same
`prepareChat`/`answerOnce` seam every other surface uses — so the WhatsApp
channel automatically honours a configured `answerFn` and `bucketsFor`.

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
  every group; has no effect on DMs, which always reply.
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

The detector and subject-cleaner (which strips mention tokens, greetings,
and the draw verb itself to derive the picture's subject) default to a
generic set of drawing verbs with no bot-specific names; override both via
`detector: { detectPattern, stripPatterns }` if your host needs different
triggers.

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
(`bun add qrcode-terminal`); pairing-code mode does not.

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

A closed connection reconnects with exponential backoff (5s, 10s, 20s, ...
capped at 10 minutes) — hammering WhatsApp during an outage or a ban
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
