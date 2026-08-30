# Personas

Dynamic prompt layers and named greetings driven by a JSON registry. Published
as a subpath so the core install is unaffected by it:

```ts
import { createPersonaResolver, createGreeter, timeContext } from "@diegoaltoworks/chatter/personas";
```

Nothing in this module is chat- or transport-specific, and it adds no required
dependencies. It ships **no content** - no bot names, no in-character copy, no
default templates. A registry and, for greetings, template pools are always
supplied by the caller.

## Registry

A registry maps contacts and endpoints to personas, and personas to prompt
files:

```json
{
  "defaultPersona": "assistant",
  "personaProbability": 0.5,
  "personaWindowMinutes": 10,
  "contacts": {
    "+15551234567": { "name": "Sam", "role": "admin", "persona": "formal", "probability": 1 }
  },
  "endpoints": {
    "support-sim": { "persona": "formal" }
  },
  "personas": {
    "assistant": { "name": "Assistant", "prompt": "prompts/assistant.md" },
    "formal": { "name": "Formal", "prompt": "prompts/formal.md", "language": "en" }
  }
}
```

- `defaultPersona` is used whenever a contact is unmapped, or its roll doesn't
  land.
- `personaProbability` (default `0.5`) is the chance a mapped contact gets
  their persona on a fresh roll; a contact's own `probability` overrides it.
- `personaWindowMinutes` (default `10`) is how long a roll is held - a
  conversation keeps one voice for the window instead of switching every
  message.
- Contact keys are opaque caller-supplied ids (a channel sender id, an E.164
  number already normalized by the caller). This module does not parse or
  normalize them.
- `endpoints` binds a persona to one of the bot's own endpoints rather than to
  a sender - see [Resolving on the endpoint that was
  reached](#resolving-on-the-endpoint-that-was-reached). Its keys are
  `ChannelMessage.endpointId` values: the host-chosen name a channel was
  configured with, not a wire identity.
- `prompt` paths resolve relative to `promptsDir` (or `registryPath`'s
  directory when not set).

Pass the registry inline (`registry`, handy for tests or embedded config) or
load it from disk (`registryPath`, read once and memoized):

```ts
const resolver = createPersonaResolver({ registryPath: "config/personas.json" });
```

## Resolving a persona layer

```ts
await prepareChat({
  store,
  prompts,
  mode,
  messages,
  personaLayer: resolver.resolvePersonaLayer(senderId) ?? undefined,
});
```

`resolvePersonaLayer` rolls (or returns the currently held) persona for the
contact, loads its prompt file, and falls back to the default persona's layer
when the roll doesn't land. It returns `string | null`; `prepareChat`'s
`personaLayer` is `string | undefined`, so `?? undefined` bridges the two -
`null` (and an omitted `personaLayer`) both mean "use chatter's own default
persona".

Lower-level pieces are exposed for callers that need to share a roll across
features (e.g. a greeting that must agree with the chat that follows):

- `rollPersonaId(key)` - the persona id in effect right now, or `null`
  for "use the default".
- `personaLayerFor(personaId)` - deterministic layer for an explicit id, no
  dice roll.
- `contactFor(contactId)` - the registry's contact record, or `undefined`.
- `defaultPersonaId()` - the registry's configured default persona id.

**Failures degrade to `null`, never throw.** A missing registry file,
malformed JSON, an unknown persona id, or a missing prompt file all resolve to
`null` rather than raising into a chat request - the caller's own default
persona layer is the fallback.

### Template variables

`vars` interpolates `{{name}}` placeholders in loaded prompt files:

```ts
createPersonaResolver({ registryPath: "config/personas.json", vars: { botName: "Assistant" } });
```

### Testing

`random` and `now` are injectable, so window-stable rolls and probability
overrides are deterministic in tests:

```ts
createPersonaResolver({ registry, random: () => 0, now: () => fixedClock });
```

## Resolving on the endpoint that was reached

A bot running several identities in one process - two WhatsApp SIMs, two
Telegram tokens - may want the voice decided by **which** of them was reached
rather than by who reached it. Register those under `endpoints` and pass the
endpoint alongside the contact:

```ts
resolver.resolvePersonaLayer({ contactId: senderId, endpointId });
```

Both halves are optional, and a bare string stays the contact id, so
`resolvePersonaLayer(senderId)` keeps meaning exactly what it did.

The endpoint key is not a second flavour of the contact key:

- **It wins when both resolve.** A contact mapping still applies on endpoints
  the registry does not bind, so per-sender voices and per-endpoint voices
  compose rather than compete.
- **It needs no contact entry.** A stranger messaging a bound endpoint gets
  that endpoint's persona - the case the contact key cannot express, since an
  unknown sender has no registry entry to map.
- **It is deterministic.** No probability roll and no persona window: the
  probability machinery exists to vary a voice over time, and the identity a
  guest chose to write to is not something to vary. Only the contact path
  rolls, and an endpoint hit leaves the contact's window untouched.
- **An unbound endpoint changes nothing.** Resolution falls through to the
  contact path, roll and window included.

Channels hand `endpointId` to `personaResolver` for you, so a host wires the
two keys together once:

```ts
createWhatsAppInboundHandler({
  // ...
  personaResolver: ({ senderPhone, endpointId }) =>
    resolver.resolvePersonaLayer({ contactId: senderPhone, endpointId }) ?? undefined,
});
```

Telegram and Matrix pass the same `endpointId` next to their own `sender` key.

`endpointId` is only set by a channel genuinely running more than one endpoint
(see [Channels](./channels.md)), so a single-endpoint host sees `undefined` and
resolves on the contact exactly as before.

**This is scoped to the channel pipeline.** The HTTP chat routes
(`/api/chat`, see [Server](./server.md)) do not resolve an endpoint and are not
going to: a caller mounting those already knows which of its surfaces was hit -
it is the request's own origin or route - and can pass the persona layer it
wants directly. The endpoint key exists for callers that let chatter resolve
the persona for them.

## Named greetings

`createGreeter` builds a named-greeting lookup for known contacts, sharing the
resolver's persona window so a greeting and the chat that follows agree:

```ts
const greeter = createGreeter({
  resolver,
  templates: {
    formal: ["Good day, {name}.", "{name}, welcome back."],
    assistant: ["Hi {name}!"],
  },
});

greeter.greet(senderId); // -> "Hi Sam!" or null
```

`greet` returns `null` for an unknown contact, a contact with no `name`, or a
persona with no template pool - the greeter has no content of its own to fall
back on. `{name}` is capitalized and substituted; everything else about the
templates is the caller's.

## Time context

`timeContext(zones, now?)` formats a live clock line for prompts that answer
time-relative questions ("what's next", "today", "tomorrow"):

```ts
timeContext(["Europe/London", "America/New_York"]);
// "Current date and time: Friday 14 August 2026 at 12:00 (Europe/London) / ..."
```

An empty `zones` list returns `""`. This is the only place the module reasons
about time; everything else about a persona's content is the registry's.

## Full example

[`examples/full-bot`](../examples/full-bot/) wires a registry like the one
above into the WhatsApp channel end to end, alongside gates, images and the
scheduler.
