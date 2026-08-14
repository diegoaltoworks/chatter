/**
 * Turso flow session store tests — run against a real in-memory libsql
 * client, since what's worth proving here is the SQL: upsert-on-conflict
 * behaves as an upsert, and table creation is idempotent.
 */

import { describe, expect, test } from "bun:test";
import { createClient } from "@libsql/client";
import { createTursoFlowSessionStore } from "./session";

function memoryClient() {
  return createClient({ url: ":memory:" });
}

describe("createTursoFlowSessionStore", () => {
  test("rejects table names that are not plain identifiers", () => {
    const client = memoryClient();

    for (const name of ["sessions; DROP TABLE x", "flow-sessions", "1flows", ""]) {
      expect(() => createTursoFlowSessionStore(client, name)).toThrow(
        "Invalid flow session store table name",
      );
    }
  });

  test("returns null for an unknown session", async () => {
    const store = createTursoFlowSessionStore(memoryClient());
    expect(await store.get("unknown")).toBeNull();
  });

  test("round-trips a session through set/get", async () => {
    const store = createTursoFlowSessionStore(memoryClient());
    const state = { flowId: "booking", params: { name: "Ada" }, attempts: 1, startedAt: 1000 };

    await store.set("session-1", state);

    expect(await store.get("session-1")).toEqual(state);
  });

  test("set overwrites a prior session for the same key", async () => {
    const store = createTursoFlowSessionStore(memoryClient());

    await store.set("session-1", { flowId: "booking", params: {}, attempts: 1, startedAt: 1000 });
    await store.set("session-1", {
      flowId: "booking",
      params: { name: "Ada" },
      attempts: 2,
      startedAt: 1000,
    });

    expect(await store.get("session-1")).toEqual({
      flowId: "booking",
      params: { name: "Ada" },
      attempts: 2,
      startedAt: 1000,
    });
  });

  test("clear removes the session", async () => {
    const store = createTursoFlowSessionStore(memoryClient());
    await store.set("session-1", { flowId: "booking", params: {}, attempts: 1, startedAt: 1000 });

    await store.clear("session-1");

    expect(await store.get("session-1")).toBeNull();
  });

  test("clearing an unknown session is a no-op", async () => {
    const store = createTursoFlowSessionStore(memoryClient());
    await expect(store.clear("never-existed")).resolves.toBeUndefined();
  });

  test("keeps separate tables on one client isolated", async () => {
    const client = memoryClient();
    const bookings = createTursoFlowSessionStore(client, "booking_sessions");
    const support = createTursoFlowSessionStore(client, "support_sessions");

    await bookings.set("session-1", { flowId: "booking", params: {}, attempts: 1, startedAt: 1 });

    expect(await support.get("session-1")).toBeNull();
  });
});
