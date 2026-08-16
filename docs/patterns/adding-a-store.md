# Adding a store

"Rate/spend state that must survive restarts lives in Turso, not process
memory" (see [ARCHITECTURE.md](../ARCHITECTURE.md), invariant 8) — a
deployment runs multiple instances, so anything backed by an in-process `Map`
or counter enforces its limit per instance, not globally. `src/usage/tursoStore.ts`
and `src/scheduler/claimStore.ts` are the two shipped examples; a new store
follows the same shape.

1. **Accept a `Client` from `@libsql/client`, imported for its type only.**
   The store's own module adds no runtime dependency to a caller who only
   wants the pure logic half (a limiter, a claim predicate) — `@libsql/client`
   is already an optional peer at the package level.

2. **Create the table lazily and idempotently**, with
   `CREATE TABLE IF NOT EXISTS`, memoized per `(client, tableName)` pair in a
   module-level `WeakMap<Client, Map<string, Promise<unknown>>>`. Per-client
   *and* per-table, not a single memo: a caller can pass an arbitrary client
   and table name, and a single memo would silently skip table creation for
   every table after the first one to run against that client.

3. **If the table name is a parameter, not a constant, validate it before
   interpolating it into SQL** — a plain-identifier regex
   (`/^[A-Za-z_][A-Za-z0-9_]*$/`), same as `scheduler/claimStore.ts`'s
   `VALID_TABLE_NAME`. The name reaches the query string directly; libsql's
   parameter binding covers values, not identifiers.

4. **Make the operation that matters atomic**, not read-then-write. A claim
   or reservation is a single upsert with a `WHERE` clause mirroring a pure
   predicate function you also export (see `canClaim` in
   `scheduler/claimStore.ts`) — export the predicate so its logic is unit
   tested directly, and keep a comment noting it has to stay in sync with the
   SQL. Two instances racing the same key must not both win.

5. **Test it against a real in-memory libsql client**
   (`createClient({ url: "file::memory:" })`), not a mock — the property
   under test is "the SQL actually enforces the invariant," which a mock
   cannot prove. Cover: idempotent table creation (calling twice doesn't
   throw), the atomic claim/reservation under concurrent callers, and the
   pure predicate function on its own. Follow `src/usage/tursoStore.test.ts`
   or `src/scheduler/claimStore.test.ts`.

6. **Document the multi-instance-safety property** in the module doc
   (`docs/<name>.md`) the way [usage.md](../usage.md) and
   [scheduler.md](../scheduler.md) do — a consumer deciding whether to trust
   a limit needs to know it's enforced across instances, not just that a
   number gets stored somewhere.
