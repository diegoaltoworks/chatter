# Full bot

A complete, config-driven wiring of chatter's server with every optional
seam it supports: the WhatsApp channel, a persona registry, reply gates
(allowlist, DM/group rate limits), image requests, and a scheduler tick.
No real credentials are included - every value comes from the environment.

> **ToS warning.** The WhatsApp channel is built on
> [Baileys](https://github.com/WhiskeySockets/Baileys), an unofficial
> client. Linking a number this way carries a real risk of that number
> being banned. See [docs/channels.md](../../docs/channels.md).

## Run it

```bash
cd examples/full-bot
bun install

export OPENAI_API_KEY="sk-..."
export TURSO_URL="libsql://..."
export TURSO_AUTH_TOKEN="..."
export CHATTER_SECRET="your-secret-key"
export WA_SESSION_SECRET="$(openssl rand -base64 32)"

# Optional
export WA_SESSION_IDS="default"                  # comma-separated for multiple numbers
export WA_CHAT_ALLOWLIST="123456789@g.us"        # empty = every group
export CLOUDINARY_CLOUD_NAME="..."
export CLOUDINARY_API_KEY="..."
export CLOUDINARY_API_SECRET="..."
export IMAGE_LIMIT_PER_DAY="5"                   # per-sender daily image cap

bun run start
```

Then pair a number with the bundled CLI (see
[docs/channels.md#pairing](../../docs/channels.md#pairing)):

```bash
bunx wa-pair
```

## What's wired up

- **WhatsApp channel** (`createWhatsAppChannel` + `createWhatsAppInboundHandler`)
  - every inbound message is gated (allowlist, DM/group rate limits, loop
  guard) and answered through the same `prepareChat`/`answerFn` seam every
  other chatter surface uses.
- **Personas** (`config/personas.json`) - a neutral, two-persona registry:
  `assistant` (default) and `formal` (for a specific contact). Swap in your
  own contacts and prompt files; this module ships no content of its own.
- **Images** - optional; inert unless `CLOUDINARY_*` and `OPENAI_API_KEY`
  are set. A drawing request routes through `./images` with a daily
  per-sender cap.
- **Scheduler** - starts ticking with an empty `fetchPending`; replace it
  with your own store of due reminders/nudges (chatter stores no schedule
  content of its own).

See [docs/channels.md](../../docs/channels.md),
[docs/personas.md](../../docs/personas.md),
[docs/images.md](../../docs/images.md) and
[docs/scheduler.md](../../docs/scheduler.md) for the full reference.
