/**
 * createMCPServer retrieval-backend wiring tests.
 *
 * Mirrors src/server.test.ts's "createServer retriever" block: config.database
 * is required only when no config.retriever is supplied, and a supplied
 * retriever is used as-is instead of building the default VectorStore.
 */

import { describe, expect, test } from "bun:test";
import { createMCPServer } from "./mcp-server";
import type { MCPServerOptions } from "./mcp-server/types";

function baseConfig(): MCPServerOptions {
  return {
    bot: {
      name: "Test Bot",
      personName: "Test Person",
      publicUrl: "http://localhost",
      description: "MCP server factory test bot",
    },
    openai: { apiKey: "test-key-not-used" },
    database: { url: "file::memory:", authToken: "" },
    logging: { console: false },
  };
}

describe("createMCPServer retriever", () => {
  test("fails fast, naming the missing config, when neither database nor retriever is set", async () => {
    const { database: _database, ...withoutDatabase } = baseConfig();

    await expect(createMCPServer(withoutDatabase)).rejects.toThrow(
      /config\.database is required unless config\.retriever is set/,
    );
  });

  test("a custom retriever skips the default VectorStore and libsql connection entirely", async () => {
    const { database: _database, ...withoutDatabase } = baseConfig();
    let built = false;
    const retriever = {
      build: async () => {
        built = true;
      },
      query: async () => ["custom context"],
    };

    await expect(createMCPServer({ ...withoutDatabase, retriever })).resolves.toBeDefined();

    expect(built).toBe(true);
  });

  test("a retriever without build() boots fine - build is optional on the interface", async () => {
    const { database: _database, ...withoutDatabase } = baseConfig();
    const retriever = { query: async () => [] };

    await expect(createMCPServer({ ...withoutDatabase, retriever })).resolves.toBeDefined();
  });

  test("database and retriever together: the retriever is used, not the default VectorStore", async () => {
    let queried = false;
    const retriever = {
      query: async () => {
        queried = true;
        return [];
      },
    };

    await expect(createMCPServer({ ...baseConfig(), retriever })).resolves.toBeDefined();
    // build() isn't defined on this retriever, and nothing calls query() at
    // startup - this just locks that construction succeeds with both set.
    expect(queried).toBe(false);
  });
});
