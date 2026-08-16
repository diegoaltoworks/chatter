# Scheduler

An exactly-once outbound scheduling primitive for anything that fires a
message at a caller-chosen time - reminders, nudges, follow-ups. Published as
a subpath so the core install is unaffected by it:

```ts
import { createScheduler } from "@diegoaltoworks/chatter/scheduler";
```

## Content-free

Chatter stores no schedule data of its own. You supply candidate entries on
every tick - your own store, a cron table, a queue, anything - and this
module adds the parts that are genuinely hard to get right once more than one
instance is running: an exactly-once claim, a fire-time grace window, a
compose step that never blocks delivery on failure, and delivery through the
channel sender registry.

```ts
interface ScheduleEntry {
  id: string; // stable - the claim table's primary key
  fireAt: number; // epoch ms
  channel: string; // sender-registry channel name
  chatId: string; // channel-specific recipient id
  payload?: unknown; // opaque - chatter never reads it
}
```

## The scheduler

```ts
import { createScheduler } from "@diegoaltoworks/chatter/scheduler";

const scheduler = createScheduler({
  db: deps.db, // the libsql handle chatter already opened
  senders: deps.senders, // the channel sender registry
  fetchPending: () => myStore.dueWithinLookahead(), // your own candidates
  fallbackMessage: "You have a reminder.",
});

scheduler.start(); // ticks on intervalMs (default 60s)
// scheduler.stop() when shutting down
```

`fetchPending` runs once per tick and returns whatever entries your own store
considers pending - this module does not care how far ahead it looks, only
what's due right now. Call `scheduler.tickOnce()` directly (bypassing the
interval) for tests or a manually triggered run.

## Exactly-once claim

Two instances (a rolling deploy, a multi-region deployment) may tick at the
same moment. Each due entry is claimed with a single atomic upsert against a
Turso table keyed on `entry.id` - the losing instance gets zero rows back, no
separate read-then-write race. A failed send **releases** the claim (deletes
the row) so a later tick - this instance or another - retries it, rather than
losing the message. An instance that dies mid-delivery without releasing
leaves its claim to go stale instead: after `claimTimeoutMs` (default 2
minutes) with no renewal, another instance may take it over - this is what
`claimed_at` is for, mirroring the WhatsApp deploy lease's staleness check
(see [Channels](./channels.md)).

This makes delivery exactly-once on a clean success or a clean failure, but
not stronger than that: a send that reports success ambiguously (the
transport delivered the message, then the call itself timed out or errored)
can be retried and duplicate; a claim that goes stale from `claimTimeoutMs`
before the crashed instance's send actually failed can also duplicate. Don't
build on a guarantee stronger than "no double-send in the common case,
at-least-once on an ambiguous failure."

## Grace window

An entry stops being eligible once its fire time is more than `graceMs` (default
5 minutes) in the past - a tick that runs late (the process was down, a
deploy took a while) does not deliver a message hours after it was due. A
stale entry is never claimed; it is simply reported and skipped.

## Compose step

`compose` turns an entry into outbound text. It's entirely optional: unset,
delivery uses `fallbackMessage` for every entry (fine for a fixed reminder
line). A thrown or rejected compose, or one that returns a blank string,
always falls back to `fallbackMessage` - a compose failure never blocks
delivery.

For an LLM-composed message, `createAnswerCompose` wraps `answerOnce` so
`answerFn` (see [UI Integrations](./integrations.md)) is honoured the same
way every other chat surface honours it:

```ts
import { createAnswerCompose } from "@diegoaltoworks/chatter/scheduler";

const compose = createAnswerCompose({
  client: deps.client,
  system: "Write a short, friendly reminder.",
  buildMessages: (entry) => [{ role: "user", content: JSON.stringify(entry.payload) }],
});
```

## Delivery

Delivery goes through `deps.senders` (see [Channels](./channels.md)) by
`entry.channel` and `entry.chatId`. Set `voiceAttempted: true` to try
`sendVoice` first when the channel supports it; text is always the guaranteed
fallback if voice is unsupported or fails, so delivery never silently drops a
message because one channel capability was unavailable. The composed text is
what a channel's `sendVoice` receives as its payload - a channel expecting
something else (an audio buffer, say) is responsible for turning it into one.

## Lower-level pieces

`createScheduler` is a thin orchestration layer over pieces exported
individually, for callers who want to run their own tick loop:

- `dueDrops(entries, now, graceMs)` / `staleDrops(entries, now, graceMs)` -
  the pure grace-window filters.
- `createTursoScheduleClaimStore(client, instanceId, tableName?)` - the claim
  store alone.
- `composeMessage(entry, compose, fallbackMessage)` - the compose step alone.
- `deliver(entry, message, { senders, voiceAttempted? })` - the delivery step
  alone.
- `runTick(entries, options)` - one full tick (claim, compose, deliver) over
  a caller-supplied entry list, without the interval.
