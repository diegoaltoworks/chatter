# Usage Metering

Daily spend guards for anything that costs money per call — image generation,
speech synthesis, a premium model tier. Published as a subpath so the core
install is unaffected by it:

```ts
import {
  createDailyLimiter,
  createTursoUsageStore,
  pickDailyLimit,
} from "@diegoaltoworks/chatter/usage";
```

Nothing in this module is chat-specific, and it adds no required dependencies.
The limiter is pure; only the shipped Turso store touches a database, and it
reuses the `@libsql/client` connection chatter already holds.

## Two caps, one reservation

Every metered resource gets two ceilings: how much one caller may spend per
day, and how much everyone together may spend per day. A limiter enforces both
in a single call.

Build the store on `deps.db` — the libsql handle chatter already opened for
retrieval, passed to `customRoutes` and channels — rather than opening a second
connection of your own:

```ts
await createServer({
  // ...
  customRoutes: (app, deps) => {
    const imageLimiter = createDailyLimiter(
      {
        perKeyDailyLimit: pickDailyLimit(process.env.IMAGE_DAILY_LIMIT, 5),
        globalDailyLimit: pickDailyLimit(process.env.IMAGE_GLOBAL_DAILY_LIMIT, 200),
      },
      { store: createTursoUsageStore(deps.db, "image_usage") },
    );

    app.post("/images", async (c) => {
      const check = await imageLimiter.checkAndReserve(senderId);
      if (!check.allowed) {
        return c.json({
          error:
            check.reason === "per-key"
              ? "You've used your image quota for today."
              : "Image generation is at capacity for today.",
        });
      }

      // ...now spend the money.
    });
  },
});
```

Outside a chatter server, any `@libsql/client` `Client` works — construct one
with `createClient` and pass it in the same way.

The key is whatever identifies a caller on your surface: a channel sender id, a
JWT subject, an API key name. Counters roll over at **UTC** midnight, so all
instances of a deployment agree on when the day changed regardless of where
they run.

Give each metered resource **its own table**. Sharing one would make unrelated
features compete for a single global counter.

### Reserve once, before you spend

`checkAndReserve` increments permanently and unconditionally. There is no
release path, by design — a reservation that could be released is a
read-then-write, and a read-then-write across instances races.

The consequences are worth stating plainly:

- Call it **exactly once per logical request**. A duplicate call, or a retry
  after a transient failure, permanently burns a second unit of quota for a
  request that was never delivered.
- **Blocked calls still count.** Tripping the per-key cap consumes one of that
  key's units, and a call blocked by the *global* cap has already consumed one
  of the caller's own units on the way there.
- **Check your cache first.** If a result can be served without paying for it,
  a cache hit should never reach the limiter — otherwise free answers cost
  quota.

### Why per-key increments first

The per-key counter increments before the global one, so a caller already at
its own cap never touches the shared budget. One caller hammering an endpoint
cannot drain everyone else's day.

The mirror case is accepted rather than fixed: once the global cap is
exhausted, every further caller still burns a personal unit to be told no. That
trade favours guarding against the common cost risk over the rare one, and it
is what makes the ordering worth relying on.

## Storage

`createTursoUsageStore(client, tableName)` is the shipped binding. It creates
its table idempotently on first use (once per client *and* table), then counts
with a single atomic `INSERT ... ON CONFLICT ... RETURNING` statement — so
concurrent instances each receive a distinct number and the cap holds across a
multi-instance deployment. Table names are interpolated into SQL and are
therefore restricted to plain identifiers; anything else throws at construction
time.

Counter state lives in the database rather than process memory precisely
because deployments run more than one instance, and a restart must not reset
anyone's daily spend.

Any other backing store works too — `DailyLimitsStore` is a structural
interface with one method:

```ts
interface DailyLimitsStore {
  incrementAndGet(scope: "key" | "global", key: string, day: string): Promise<number>;
}
```

The one hard requirement on an implementation is that it increments and reads
back **atomically**. A store that reads then writes will let two instances see
room under a cap that only had space for one.

Store failures propagate out of `checkAndReserve` rather than being swallowed.
A spend guard that fails open is not a spend guard; decide at the call site
whether an unreachable database should block the feature or not.

## Configuration values

`pickDailyLimit(value, fallback)` reads a cap out of loosely-typed
configuration such as an environment variable. A non-negative integer wins;
unset, blank, negative, fractional and unparseable values all fall back. Blank
includes whitespace-only, which is the dangerous case: `Number(" ")` is `0`, so
a stray space in a `.env` line would otherwise read as a cap of zero and switch
the feature off entirely.

This matters more than it looks in the other direction too — an unguarded
`Number(...)` yields `NaN`, which compares false against every count and would
silently disable the cap. `createDailyLimiter` does not validate its config, so
caps must be finite non-negative integers by the time they reach it;
`pickDailyLimit` is the supported way to get there.

A cap of `0` is honoured as zero — it blocks the very first call, which is the
usual way to switch a paid feature off deliberately.
