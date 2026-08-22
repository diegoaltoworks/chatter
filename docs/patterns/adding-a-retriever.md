# Adding a retriever

`prepareChat` (`src/core/pipeline.ts`) never talks to a database directly - it
calls `store.query(query, k, allowedBuckets)` against whatever implements the
`Retriever` interface (`src/core/retrieval.ts`). `VectorStore` is the shipped
implementation: brute-force cosine similarity over OpenAI embeddings stored in
Turso, fine for a knowledge base of a few thousand chunks and nothing this
codebase optimizes further. `Retriever` is the scaling path for when that stops
being true - pgvector, sqlite-vec, Qdrant, a managed vector database, or a
retrieval-augmented service another team already runs.

## The interface

```typescript
interface Retriever {
  query(query: string, k: number, allowedBuckets: string[]): Promise<string[]>;
  build?(): Promise<void>;
}
```

- **`query`** returns up to `k` chunks, most relevant first, drawn only from
  `allowedBuckets`. Bucket scoping is the caller's job (`resolveBuckets`
  already enforces the anonymous-cannot-widen invariant - see
  [ARCHITECTURE.md](../ARCHITECTURE.md), invariant 2) - a `Retriever` just
  has to honor whichever bucket names it's given and never return chunks from
  a bucket that wasn't asked for.
- **`build`** is optional. `createServer`/`createMCPServer` call it once at
  startup, before anything queries the store, if it's present. Implement it
  for a one-time ingest/embed step (what `VectorStore.build()` does);
  omit it for a retriever backed by an index another process already keeps
  current. Every instance boots, so `build` runs once per instance against
  one shared backend: if yours prunes or overwrites anything, guard the
  destructive part with a single-writer lock the way `VectorStore` does (see
  `src/core/buildLock.ts`), or a rolling deploy will have two builds deleting
  each other's writes.

## Wiring it in

Set `ChatterConfig.retriever` (or the same field on `MCPServerOptions`) to
your implementation and drop `database` entirely if nothing else needs a
libsql connection:

```typescript
import { createServer } from "@diegoaltoworks/chatter";

const app = await createServer({
  bot: { name: "MyBot", personName: "Assistant", publicUrl: "https://example.com", description: "..." },
  openai: { apiKey: process.env.OPENAI_API_KEY },
  retriever: myPgvectorRetriever,
  // no `database` - nothing here needs libsql
});
```

`config.database` becomes required again only when you skip `retriever` - the
default `VectorStore` has nowhere else to keep chunks and embeddings. Supplying
neither fails fast at startup with an error naming the missing one, instead of
throwing on the first chat request. Supplying `database` alongside a custom
`retriever` is fine too - a channel, the scheduler, or your own `customRoutes`
can still use `deps.db`, which is opened whenever `config.database` is set,
independently of which retriever answers `prepareChat`.

A host that configures `retriever` and never sets `database` never triggers a
load of `@libsql/client` at all (it's an optional peer): `createServer` and
`createMCPServer` both dynamically import the default `VectorStore` machinery
only along the branch that needs it, so a consumer who brings their own
retrieval backend can install Chatter without the Turso client.

## Embeddings without OpenAI

`VectorStore` itself takes an `Embedder` - `(input: string[]) => Promise<number[][]>`
- rather than an OpenAI client, so it isn't hard-wired to one embeddings
provider either. `createOpenAIEmbedder(client)` is the adapter
`createServer` uses by default. It takes no model parameter: `VectorStore`
labels every stored row with the embedding model it was written under and never
re-embeds rows written under a different one, so the model is pinned rather
than passed in. Write your own `Embedder` to back `VectorStore` with a
different provider while keeping its Turso storage and cosine search:

```typescript
import { VectorStore, type Embedder } from "@diegoaltoworks/chatter";

const embed: Embedder = async (input) => myProvider.embed(input);
const store = new VectorStore(embed, { databaseClient: db, knowledgeDir });
```

## Testing

Fake a `Retriever` the same way pipeline tests already do - an object literal
with a `query` (and optional `build`) function is enough; nothing about the
interface requires a real database. See `src/core/pipeline.test.ts` and
`src/server.test.ts`'s "createServer retriever" tests for the pattern.
