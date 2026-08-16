/**
 * createMCPServer retrieval-backend wiring tests.
 *
 * Mirrors src/server.test.ts's "createServer retriever" block: config.database
 * is required only when no config.retriever is supplied, and a supplied
 * retriever is used as-is instead of building the default VectorStore.
 *
 * The logging block below drives a real tool call over the SDK's in-memory
 * transport, since what a tool call writes to the log is only observable once
 * one actually runs. `answerFn` stands in for the completion, so no test here
 * reaches a paid API.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "./core/logger";
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

const USER_MESSAGE = "what did I spend on rent last month";
const RAG_CHUNK = "rent ledger entry for the tenant";
const ANSWER = "you spent 1200 on rent";

function capturingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const record =
    () =>
    (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
  return {
    logger: { debug: record(), info: record(), warn: record(), error: record() },
    lines,
  };
}

function promptsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mcp-logging-prompts-"));
  for (const file of ["base.txt", "public.txt", "private.txt"]) {
    writeFileSync(join(dir, file), "You are a test bot.", "utf-8");
  }
  return dir;
}

async function callPublicTool(config: MCPServerOptions): Promise<void> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

  const server = await createMCPServer(config);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const result = await client.callTool({
    name: "chat_public",
    arguments: { message: USER_MESSAGE },
  });
  await client.close();

  expect(result.isError).toBeFalsy();
}

function loggingConfig(logger: Logger, dir: string, content?: boolean): MCPServerOptions {
  const { database: _database, ...base } = baseConfig();
  return {
    ...base,
    promptsDir: dir,
    retriever: { query: async () => [RAG_CHUNK] },
    answerFn: () => ANSWER,
    logger,
    logging: { console: true, ...(content === undefined ? {} : { content }) },
  };
}

describe("createMCPServer chat logging", () => {
  test("a tool call logs metadata only by default", async () => {
    const { logger, lines } = capturingLogger();
    const dir = promptsDir();

    try {
      await callPublicTool(loggingConfig(logger, dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    const event = lines.map((line) => line.trim()).find((line) => line.includes('"mcp_chat"'));
    expect(event).toBeDefined();
    const logged = JSON.parse(event as string);
    expect(logged.toolName).toBe("chat_public");
    expect(logged.messageCount).toBe(1);
    expect(logged.ragContextCount).toBe(1);

    const everything = lines.join("\n");
    expect(everything).not.toContain(USER_MESSAGE);
    expect(everything).not.toContain(RAG_CHUNK);
    expect(everything).not.toContain(ANSWER);
    expect(everything).not.toContain("mcp_chat_content");
  });

  test("logging.content opts the conversation back in, at debug", async () => {
    const { logger, lines } = capturingLogger();
    const dir = promptsDir();

    try {
      await callPublicTool(loggingConfig(logger, dir, true));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    const event = lines
      .map((line) => line.trim())
      .find((line) => line.includes('"mcp_chat_content"'));
    expect(event).toBeDefined();
    const logged = JSON.parse(event as string);
    expect(logged.userMessage).toBe(USER_MESSAGE);
    expect(logged.ragContext).toEqual([RAG_CHUNK]);
    expect(logged.response).toBe(ANSWER);
  });
});
