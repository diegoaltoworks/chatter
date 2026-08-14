/**
 * createServer custom-route mounting tests
 *
 * Runs the real server factory against an in-memory libsql database and an
 * empty knowledge directory, so no paid API is reached: with nothing to embed,
 * the vector store build never calls OpenAI.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./server";
import type { ChatterConfig, CustomRoutes } from "./types";

let knowledgeDir: string;

beforeAll(async () => {
  knowledgeDir = await mkdtemp(join(tmpdir(), "chatter-server-unit-"));
});

afterAll(async () => {
  await rm(knowledgeDir, { recursive: true, force: true });
});

function config(customRoutes: CustomRoutes): ChatterConfig {
  return {
    bot: {
      name: "Test Bot",
      personName: "Test Person",
      publicUrl: "http://localhost",
      description: "Server factory test bot",
    },
    openai: { apiKey: "test-key-not-used" },
    // In-memory libsql: no Turso credentials, no network.
    database: { url: "file::memory:", authToken: "" },
    knowledgeDir,
    features: { headless: true },
    customRoutes,
  };
}

describe("createServer customRoutes", () => {
  test("awaits async mounting before returning the app", async () => {
    const order: string[] = [];

    const app = await createServer(
      config(async (app) => {
        order.push("mount:start");
        // Deferred work a plugin would do here: migrations, registries.
        await new Promise((resolve) => setTimeout(resolve, 10));
        order.push("mount:end");
        app.get("/async/mounted", (c) => c.json({ mounted: true }));
      }),
    );

    // Both halves of the async mount ran before createServer resolved, so the
    // route it registered after awaiting is already reachable.
    expect(order).toEqual(["mount:start", "mount:end"]);

    const res = await app.fetch(new Request("http://localhost/async/mounted"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ mounted: true });
  });

  test("still mounts synchronous customRoutes", async () => {
    const app = await createServer(
      config((app) => {
        app.get("/sync/mounted", (c) => c.json({ mounted: true }));
      }),
    );

    const res = await app.fetch(new Request("http://localhost/sync/mounted"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ mounted: true });
  });

  test("accepts an expression-bodied sync mount that returns the app", async () => {
    // Hono's route methods return the app for chaining, so this shape returns a
    // value. It must stay assignable to CustomRoutes - typecheck is the real
    // assertion here; the request confirms it also mounts.
    const app = await createServer(
      config((app) => app.get("/chained/mounted", (c) => c.json({ mounted: true }))),
    );

    const res = await app.fetch(new Request("http://localhost/chained/mounted"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ mounted: true });
  });

  test("can run database work during an async mount", async () => {
    const app = await createServer(
      config(async (app, deps) => {
        // Async mounting can use deps.db directly - the connection is open by
        // the time customRoutes runs.
        await deps.db.execute("CREATE TABLE IF NOT EXISTS plugin_state (k TEXT PRIMARY KEY)");
        await deps.db.execute("INSERT INTO plugin_state(k) VALUES('migrated')");
        app.get("/async/state", async (c) => {
          const res = await deps.db.execute("SELECT k FROM plugin_state");
          return c.json({ rows: res.rows.map((r) => String(r.k)) });
        });
      }),
    );

    // The migration ran before the app was returned, so the route it backs
    // already sees its data on the first request.
    const res = await app.fetch(new Request("http://localhost/async/state"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rows: ["migrated"] });
  });

  test("propagates a rejected async mount instead of returning a half-built app", async () => {
    const boom = new Error("migration failed");

    await expect(
      createServer(
        config(async () => {
          await Promise.resolve();
          throw boom;
        }),
      ),
    ).rejects.toThrow("migration failed");
  });
});
