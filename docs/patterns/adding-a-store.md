# Adding a store

"Shared state that must survive a restart lives behind an injectable store
interface, with libsql as the shipped implementation" (see
[ARCHITECTURE.md](../ARCHITECTURE.md), invariant 8) - a deployment runs
multiple instances, so anything backed by an in-process `Map` or counter
enforces its limit per instance, not globally. `src/usage/tursoStore.ts`,
`src/scheduler/claimStore.ts`, `src/channels/whatsapp/lease.ts` and
`src/channels/whatsapp/authState.ts` (`WaAuthKV`) are the shipped examples; a
new store follows the same shape.

1. **Define the store as a plain interface first, independent of any
   backend.** A caller depends on the interface (`ScheduleClaimStore`,
   `WaLeaseStore`, `WaAuthKV`, ...), not on Turso - the config field that
   accepts it (`SchedulerConfig.claimStore`, `WhatsAppChannelConfig.leaseStore`
   / `authStore`, ...) is optional and defaults to the shipped
   `createTurso*` factory only when unset. This is what makes a store
   swappable: a test fakes the interface directly, and a host that wants a
   different backend implements the same few methods.

2. **Ship a `createTurso<Name>` factory implementing that interface**,
   accepting a `Client` from `@libsql/client` imported for its type only. The
   store's own module adds no runtime dependency to a caller who only wants
   the pure logic half (a limiter, a claim predicate) - `@libsql/client` is
   already an optional peer at the package level.

3. **Create the table lazily and idempotently**, with
   `CREATE TABLE IF NOT EXISTS`, memoized per `(client, tableName)` pair in a
   module-level `WeakMap<Client, Map<string, Promise<unknown>>>`. Per-client
   *and* per-table, not a single memo: a caller can pass an arbitrary client
   and table name, and a single memo would silently skip table creation for
   every table after the first one to run against that client.

4. **If the table name is a parameter, not a constant, validate it before
   interpolating it into SQL** - a plain-identifier regex
   (`/^[A-Za-z_][A-Za-z0-9_]*$/`), same as `scheduler/claimStore.ts`'s
   `VALID_TABLE_NAME`. The name reaches the query string directly; libsql's
   parameter binding covers values, not identifiers.

5. **Make the operation that matters atomic**, not read-then-write. A claim
   or reservation is a single upsert with a `WHERE` clause mirroring a pure
   predicate function you also export (see `canClaim` in
   `scheduler/claimStore.ts`) - export the predicate so its logic is unit
   tested directly, and keep a comment noting it has to stay in sync with the
   SQL. Two instances racing the same key must not both win.

6. **Keep anything that needs to interpret values (encryption, JSON
   encode/decode) above the store, not inside it.** `WaAuthKV` only reads and
   writes opaque strings; `authState.ts`'s `useAuthState` owns the
   encrypt/decrypt and JSON handling around it. A custom `WaAuthKV` then
   cannot accidentally persist plaintext, and the store stays swappable for a
   backend that has no opinion about the payload shape.

7. **Test the Turso-backed factory against a real in-memory libsql client**
   (`createClient({ url: "file::memory:" })`), not a mock - the property
   under test is "the SQL actually enforces the invariant," which a mock
   cannot prove. Cover: idempotent table creation (calling twice doesn't
   throw), the atomic claim/reservation under concurrent callers, and the
   pure predicate function on its own. Follow `src/usage/tursoStore.test.ts`
   or `src/scheduler/claimStore.test.ts`. Separately, test the interface
   itself against a minimal in-memory fake, proving the seam that consumes it
   (the scheduler, the channel) works with any conforming implementation, not
   just the shipped one.

8. **Document the multi-instance-safety property** in the module doc
   (`docs/<name>.md`) the way [usage.md](../usage.md) and
   [scheduler.md](../scheduler.md) do - a consumer deciding whether to trust
   a limit needs to know it's enforced across instances, not just that a
   number gets stored somewhere. Document the injection point too, so a
   caller knows they can supply their own backend instead of libsql.
