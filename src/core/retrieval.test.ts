/**
 * Vector store connection tests
 *
 * Uses a faked libsql client and OpenAI client so the connection wiring can be
 * asserted without touching Turso or OpenAI.
 */

import { describe, expect, test } from "bun:test";
import type { Client as LibsqlClient } from "@libsql/client";
import type OpenAI from "openai";
import type { ServerDependencies } from "../types";
import { VectorStore } from "./retrieval";

interface ExecuteCall {
  sql: string;
  args: unknown;
}

function createFakeDb() {
  const calls: ExecuteCall[] = [];

  const db = {
    execute: async (stmt: string | { sql: string; args?: unknown }) => {
      const sql = typeof stmt === "string" ? stmt : stmt.sql;
      const args = typeof stmt === "string" ? undefined : stmt.args;
      calls.push({ sql, args });
      return { rows: [{ id: "chunk-1", text: "injected context", embedding: "[1,0]" }] };
    },
  } as unknown as LibsqlClient;

  return { db, calls };
}

function createFakeOpenAI(embedding: number[]) {
  return {
    embeddings: {
      create: async () => ({ data: [{ embedding }] }),
    },
  } as unknown as OpenAI;
}

describe("VectorStore connection", () => {
  test("exposes the injected client instead of opening a second connection", () => {
    const { db } = createFakeDb();

    const store = new VectorStore(createFakeOpenAI([1, 0]), { databaseClient: db });

    expect(store.db).toBe(db);
  });

  test("runs queries against the injected client", async () => {
    const { db, calls } = createFakeDb();
    const store = new VectorStore(createFakeOpenAI([1, 0]), { databaseClient: db });

    const results = await store.query("a question", 3, ["base"]);

    expect(results).toEqual(["injected context"]);
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain("FROM chunks c");
    expect(calls[0].args).toEqual(["base"]);
  });

  test("opens a connection of its own when given credentials", () => {
    const openai = createFakeOpenAI([1, 0]);
    const credentials = { databaseUrl: "file::memory:", databaseAuthToken: "" } as const;

    const first = new VectorStore(openai, credentials);
    const second = new VectorStore(openai, credentials);

    // Each credentials-built store opens its own connection - which is exactly
    // the duplication injecting a client avoids.
    expect(typeof first.db.execute).toBe("function");
    expect(first.db).not.toBe(second.db);
  });

  test("satisfies the ServerDependencies db handle from the store's own client", () => {
    const { db } = createFakeDb();
    const client = createFakeOpenAI([1, 0]);
    const store = new VectorStore(client, { databaseClient: db, knowledgeDir: "./knowledge" });

    // Locks the contract createServer relies on: the handle it publishes is the
    // store's client, so consumers of deps.db reuse the one open connection.
    const deps: Pick<ServerDependencies, "client" | "store" | "db"> = {
      client,
      store,
      db: store.db,
    };

    expect(deps.db).toBe(db);
  });
});
