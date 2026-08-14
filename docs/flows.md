# Flows

A directory-loaded slot-filling engine for multi-turn, structured
interactions — "book an appointment", "file a return", anything that needs a
few pieces of information gathered across several messages before it can run.
Published as a subpath so the core install is unaffected by it:

```ts
import { createFlowEngine, createTursoFlowSessionStore } from "@diegoaltoworks/chatter/flows";
```

Nothing in this module is chat-surface- or channel-specific, and it adds no
required dependencies beyond the OpenAI client and libsql client chatter
already expects. It ships **no flows** — a flows directory, its trigger
keywords, its schema and its handler logic are always supplied by the caller.

This is also the designated future home for graph-based flow orchestration —
today's engine is intentionally the simplest thing that fills a schema over a
few turns.

## Presentation stays out

`process()` returns a structured `FlowResult` — one `message` string plus an
optional `result` payload — never per-channel text (no SMS body, no WhatsApp
body, no TwiML). Rendering the result for voice, SMS, WhatsApp or a web widget
is the calling plugin's job, not the engine's. This is what makes the engine
channel-agnostic: it never assumes how its answer will be delivered.

## A flow directory

Each flow is a directory of four files:

```
flows/
  bookAppointment/
    flow.json        # id, name, description, triggerKeywords, schema
    instructions.md   # prompt fed to parameter extraction
    handler.ts        # export const execute: FlowHandler
    prefill.ts         # optional: export const prefillFromContext: FlowPrefill
```

`flow.json`:

```json
{
  "id": "bookAppointment",
  "name": "Book Appointment",
  "description": "Books a service appointment",
  "triggerKeywords": ["book", "appointment", "schedule"],
  "schema": {
    "type": "object",
    "properties": {
      "date": { "type": "string", "description": "Appointment date" },
      "service": { "type": "string", "description": "Service requested" }
    },
    "required": ["date", "service"]
  }
}
```

`handler.ts` runs once every required param is collected, and returns the
structured result — never presentation:

```ts
import type { FlowHandler } from "@diegoaltoworks/chatter/flows";

export const execute: FlowHandler = async (params, { sessionKey }) => {
  const booking = await bookAppointment(params.date, params.service);
  return {
    success: true,
    message: `Booked for ${params.date}.`,
    result: booking,
  };
};
```

`prefill.ts` is optional — seed params from context the caller already knows
(a caller id resolved from the channel, say) before extraction runs. The
`context` argument is whatever the caller passes as `prefillContext` to
`engine.process()` (empty object when omitted):

```ts
import type { FlowPrefill } from "@diegoaltoworks/chatter/flows";

export const prefillFromContext: FlowPrefill = (sessionKey, context) => {
  return { customerId: context.customerId };
};
```

`id` must match the directory name. `triggerKeywords` and `schema.properties`
must both be non-empty — a flow with neither can never be reached or ever
complete. A directory that fails to load is skipped (logged, not fatal) so one
malformed flow does not take the rest down with it. Directories named `lib`,
`tests` or `registry` are always skipped (reserved for a flows directory's own
shared code/fixtures) — don't name a flow one of those three.

## The engine

```ts
import OpenAI from "openai";
import { createFlowEngine, createTursoFlowSessionStore } from "@diegoaltoworks/chatter/flows";

const engine = createFlowEngine({
  client: deps.client, // the OpenAI client chatter already holds
  model: "gpt-4o-mini",
  flowsDir: "./config/flows",
  sessionStore: createTursoFlowSessionStore(deps.db),
});

await engine.loadFlows();

const result = await engine.process(sessionKey, message);
if (result.isFlowActive || result.flowCompleted || result.cancelled) {
  // a flow is handling this turn — send result.message and stop here
} else {
  // nothing matched; fall through to the normal chat pipeline
}
```

`sessionKey` is whatever identifies a conversation on your surface — a phone
number, a WhatsApp JID, a web session id. The engine is channel-agnostic: it
never inspects or interprets the key, only uses it to key session state.

### Matching a message to a flow

Two steps, checked in order:

1. **Critical keywords** — an optional `keyword -> flowId` map checked first.
   A match triggers instantly, with no LLM round-trip. Unset, this step is
   disabled entirely.
2. **LLM intent detection** — when no keyword matches (or none are
   configured), the message and every loaded flow's description/keywords are
   sent to the model for classification. A detection has to clear
   `minConfidence` (default `0.7`) to trigger; anything lower falls through to
   `{ isFlowActive: false, message: "", flowCompleted: false }`, which is the
   signal to hand the message to your normal chat pipeline instead.

### Multi-turn param collection

While a flow is active for a `sessionKey`, every subsequent `process()` call
extracts more params from the message and merges them with what's already
collected. Once every required field is filled, the handler runs and the
session clears. Until then, `result.message` carries a prompt for whatever's
still missing.

A message matching a cancel keyword as a whole word/phrase (`cancel`,
`nevermind`, "never mind", `stop`, "forget it", `quit` by default — override
with `cancelKeywords`) exits the active flow immediately: `{ cancelled: true }`,
no handler call, session cleared.

A transient failure mid-flow (an extraction call that throws) returns
`{ error: true }` but **keeps** the session — the params collected so far
survive, and the next message retries rather than starting over. Set
`sessionTtlMs` to bound how long an abandoned or stuck session may sit before
it's dropped and the next message is matched fresh instead of resumed; unset,
sessions only end via completion or a cancel keyword.

### Session state

`FlowSessionStore` is a structural interface with three methods
(`get`/`set`/`clear`); `createTursoFlowSessionStore(deps.db)` is the shipped
binding. Build it on `deps.db` — the libsql handle chatter already opened —
rather than a second connection of your own. State lives in the database, not
process memory, because a deployment's next message for a given `sessionKey`
is not guaranteed to land on the same instance that handled the last one — a
session written by instance A is visible to instance B's next `process()`
call.

That's a visibility guarantee, not a concurrency one: two messages for the
same `sessionKey` processed at the same time can both read "no active
session" and both trigger a flow, or both read the same in-progress state and
race to complete it. This is expected to be rare — messaging channels
typically process one sender's messages in order — but a host expecting true
concurrent messages per session should serialize `process()` calls per
`sessionKey` itself.

```ts
interface FlowSessionStore {
  get(sessionKey: string): Promise<FlowSessionState | null>;
  set(sessionKey: string, state: FlowSessionState): Promise<void>;
  clear(sessionKey: string): Promise<void>;
}
```

Any other backing store works too, as long as it satisfies the interface.

## Lower-level pieces

`createFlowEngine` is a thin orchestration layer over pieces exported
individually, for callers who want to assemble their own flow:

- `loadFlowsFromDirectory(flowsDir)` — the loader alone.
- `createFlowRegistry(flows, criticalKeywords?)` — lookup plus the pure
  keyword-matching step.
- `detectIntent(client, model, message, flows, conversationContext?)` — the
  LLM classification step alone.
- `extractParameters(client, model, flow, message, existingParams, now?)` —
  the LLM extraction step alone; `now` is injectable for deterministic
  date-relative prompt context in tests.
- `shouldExitFlow(message, cancelKeywords?)` — the pure cancellation check.
