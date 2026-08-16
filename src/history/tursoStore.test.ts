/**
 * Turso history store tests — run against a real in-memory libsql client,
 * since what's worth proving here is the SQL: turns round-trip in order,
 * table creation is idempotent, and pruning keeps a conversation bounded.
 */

import { describe, expect, test } from "bun:test";
import { createClient } from "@libsql/client";
import { createTursoHistoryStore } from "./tursoStore";

function memoryClient() {
  return createClient({ url: ":memory:" });
}

describe("createTursoHistoryStore", () => {
  test("rejects table names that are not plain identifiers", () => {
    const client = memoryClient();

    for (const name of ["history; DROP TABLE x", "chat-history", "1history", ""]) {
      expect(() => createTursoHistoryStore(client, name)).toThrow(
        "Invalid history store table name",
      );
    }
  });

  test("returns an empty array for an unknown conversation", async () => {
    const store = createTursoHistoryStore(memoryClient());
    expect(await store.load("unknown", 10)).toEqual([]);
  });

  test("loads appended turns oldest first", async () => {
    const store = createTursoHistoryStore(memoryClient());

    await store.append("conv-1", { role: "user", content: "hi" });
    await store.append("conv-1", { role: "assistant", content: "hello" });
    await store.append("conv-1", { role: "user", content: "how are you" });

    expect(await store.load("conv-1", 10)).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "how are you" },
    ]);
  });

  test("load honours the limit, keeping only the most recent turns", async () => {
    const store = createTursoHistoryStore(memoryClient());

    for (let i = 0; i < 5; i++) {
      await store.append("conv-1", { role: "user", content: `turn ${i}` });
    }

    expect(await store.load("conv-1", 2)).toEqual([
      { role: "user", content: "turn 3" },
      { role: "user", content: "turn 4" },
    ]);
  });

  test("keeps separate conversations isolated", async () => {
    const store = createTursoHistoryStore(memoryClient());

    await store.append("conv-1", { role: "user", content: "conv 1 message" });
    await store.append("conv-2", { role: "user", content: "conv 2 message" });

    expect(await store.load("conv-1", 10)).toEqual([{ role: "user", content: "conv 1 message" }]);
    expect(await store.load("conv-2", 10)).toEqual([{ role: "user", content: "conv 2 message" }]);
  });

  test("keeps separate tables on one client isolated", async () => {
    const client = memoryClient();
    const support = createTursoHistoryStore(client, "support_history");
    const sales = createTursoHistoryStore(client, "sales_history");

    await support.append("conv-1", { role: "user", content: "support message" });

    expect(await sales.load("conv-1", 10)).toEqual([]);
  });

  test("append prunes a conversation back down to maxPerConversation", async () => {
    const store = createTursoHistoryStore(memoryClient(), "chat_history", 3);

    for (let i = 0; i < 5; i++) {
      await store.append("conv-1", { role: "user", content: `turn ${i}` });
    }

    expect(await store.load("conv-1", 10)).toEqual([
      { role: "user", content: "turn 2" },
      { role: "user", content: "turn 3" },
      { role: "user", content: "turn 4" },
    ]);
  });

  test("rejects a non-positive or non-integer maxPerConversation", () => {
    const client = memoryClient();

    for (const value of [0, -1, 1.5]) {
      expect(() => createTursoHistoryStore(client, "chat_history", value)).toThrow(
        "Invalid history store maxPerConversation",
      );
    }
  });

  test("load returns nothing for a zero or negative limit, rather than the whole conversation", async () => {
    const store = createTursoHistoryStore(memoryClient());
    await store.append("conv-1", { role: "user", content: "hi" });

    expect(await store.load("conv-1", 0)).toEqual([]);
    expect(await store.load("conv-1", -1)).toEqual([]);
  });

  test("clear empties a conversation, leaving others untouched", async () => {
    const store = createTursoHistoryStore(memoryClient());
    await store.append("conv-1", { role: "user", content: "hi" });
    await store.append("conv-2", { role: "user", content: "hey" });

    await store.clear("conv-1");

    expect(await store.load("conv-1", 10)).toEqual([]);
    expect(await store.load("conv-2", 10)).toEqual([{ role: "user", content: "hey" }]);
  });

  test("clear on an unknown conversation is a no-op", async () => {
    const store = createTursoHistoryStore(memoryClient());
    await expect(store.clear("never-existed")).resolves.toBeUndefined();
  });

  test("rejects a non-positive or non-integer ttlMs", () => {
    const client = memoryClient();

    for (const value of [0, -1, 1.5]) {
      expect(() => createTursoHistoryStore(client, "chat_history", 200, { ttlMs: value })).toThrow(
        "Invalid history store ttlMs",
      );
    }
  });

  test("a configured ttl prunes rows older than it directly on the database, on the next append", async () => {
    let now = 1_000_000;
    const client = memoryClient();
    const store = createTursoHistoryStore(client, "chat_history", 200, {
      ttlMs: 60_000,
      now: () => now,
    });

    await store.append("conv-1", { role: "user", content: "old" });
    now += 61_000; // past the ttl
    await store.append("conv-1", { role: "user", content: "new" });

    // Asserted against the raw table, not `load` (which prunes on its own
    // and would pass even if `append`'s prune call were deleted).
    const rows = await client.execute("SELECT content FROM chat_history ORDER BY id");
    expect(rows.rows.map((r) => r.content)).toEqual(["new"]);
  });

  test("ttl pruning also runs on load, not only append", async () => {
    let now = 1_000_000;
    const store = createTursoHistoryStore(memoryClient(), "chat_history", 200, {
      ttlMs: 60_000,
      now: () => now,
    });

    await store.append("conv-1", { role: "user", content: "old" });
    now += 61_000; // past the ttl, no further append to trigger the prune

    expect(await store.load("conv-1", 10)).toEqual([]);
  });

  test("rows within the ttl survive pruning", async () => {
    let now = 1_000_000;
    const store = createTursoHistoryStore(memoryClient(), "chat_history", 200, {
      ttlMs: 60_000,
      now: () => now,
    });

    await store.append("conv-1", { role: "user", content: "recent" });
    now += 30_000; // within the ttl

    expect(await store.load("conv-1", 10)).toEqual([{ role: "user", content: "recent" }]);
  });

  test("ttl pruning is scoped to the conversation being accessed, not every stale row in the table", async () => {
    let now = 1_000_000;
    const client = memoryClient();
    const store = createTursoHistoryStore(client, "chat_history", 200, {
      ttlMs: 60_000,
      now: () => now,
    });

    await store.append("conv-1", { role: "user", content: "stale in conv-1" });
    await store.append("conv-2", { role: "user", content: "stale in conv-2" });
    now += 61_000; // both rows are now past the ttl

    // Touching only conv-1 must not prune conv-2's equally stale row. Checked
    // directly on the table: reading conv-2 back through the store would
    // trigger its own prune-on-access and mask the bug this test is for.
    await store.load("conv-1", 10);

    const rows = await client.execute("SELECT conversation_id, content FROM chat_history");
    expect(
      rows.rows.map((r) => ({ conversation_id: r.conversation_id, content: r.content })),
    ).toEqual([{ conversation_id: "conv-2", content: "stale in conv-2" }]);
  });

  test("load drops rows whose role is outside the user/assistant contract", async () => {
    const client = memoryClient();
    const store = createTursoHistoryStore(client, "chat_history");
    await store.append("conv-1", { role: "user", content: "hi" });
    // A row a migration or a host writing directly could leave behind.
    await client.execute({
      sql: "INSERT INTO chat_history (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)",
      args: ["conv-1", "system", "not a real turn", Date.now()],
    });
    await store.append("conv-1", { role: "assistant", content: "hello" });

    expect(await store.load("conv-1", 10)).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
  });
});
