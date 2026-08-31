/**
 * createServer custom-route mounting tests
 *
 * Runs the real server factory against an in-memory libsql database and an
 * empty knowledge directory, so no paid API is reached: with nothing to embed,
 * the vector store build never calls OpenAI.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiKeyManager } from "./auth/apikeys";
import type { Channel, SessionIdentityRegistry } from "./channels";
import { isEffectivelyFromSelf } from "./channels";
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
    ...baseConfig(),
    customRoutes,
  };
}

function baseConfig(): ChatterConfig {
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

describe("createServer channels", () => {
  test("starts a configured channel with full server dependencies", async () => {
    let receivedDb: unknown;
    const channel: Channel = {
      name: "fake",
      start: async (deps) => {
        receivedDb = deps.db;
      },
    };

    await createServer({ ...baseConfig(), channels: [channel] });

    expect(receivedDb).toBeDefined();
  });

  test("every channel gets the one identity registry the server owns", async () => {
    // Loop protection only works if it is the SAME map: a channel that
    // registers its identity into a private one is invisible to the next
    // channel, which then answers it as a stranger - and is answered back.
    const seen: SessionIdentityRegistry[] = [];
    const alpha: Channel = {
      name: "alpha",
      start: async (deps) => {
        seen.push(deps.identities);
        deps.identities.set("alpha", ["alpha-id"]);
      },
    };
    const beta: Channel = {
      name: "beta",
      start: async (deps) => {
        seen.push(deps.identities);
      },
    };

    await createServer({ ...baseConfig(), channels: [alpha, beta] });

    expect(seen).toHaveLength(2);
    expect(seen[1]).toBe(seen[0] as SessionIdentityRegistry);
    expect(
      isEffectivelyFromSelf(
        { fromBot: false, senderId: "alpha-id" },
        seen[1] as Map<string, string[]>,
      ),
    ).toBe(true);
  });

  test("two servers in one process do not share an identity registry", async () => {
    // Scoped like stopChannels: each createServer call protects its own
    // channels, and neither can mistake the other's bot for one of its own.
    const seen: SessionIdentityRegistry[] = [];
    const probe = (name: string): Channel => ({
      name,
      start: async (deps) => {
        seen.push(deps.identities);
      },
    });

    await createServer({ ...baseConfig(), channels: [probe("one")] });
    await createServer({ ...baseConfig(), channels: [probe("two")] });

    expect(seen[0]).not.toBe(seen[1]);
  });

  test("a throwing channel is logged and does not crash the server", async () => {
    const boom = new Error("connect failed");
    const badChannel: Channel = {
      name: "broken",
      start: async () => {
        throw boom;
      },
    };
    let goodStarted = false;
    const goodChannel: Channel = {
      name: "fine",
      start: async () => {
        goodStarted = true;
      },
    };

    const app = await createServer({ ...baseConfig(), channels: [badChannel, goodChannel] });

    expect(app).toBeDefined();
    expect(goodStarted).toBe(true);
  });

  test("stopChannels() stops every channel that started successfully", async () => {
    const stopped: string[] = [];
    const badChannel: Channel = {
      name: "broken",
      start: async () => {
        throw new Error("connect failed");
      },
      stop: async () => {
        stopped.push("broken");
      },
    };
    const channelA: Channel = {
      name: "a",
      start: async () => {},
      stop: async () => {
        stopped.push("a");
      },
    };
    const channelB: Channel = {
      name: "b",
      start: async () => {},
      stop: async () => {
        stopped.push("b");
      },
    };

    const app = await createServer({ ...baseConfig(), channels: [badChannel, channelA, channelB] });
    await app.stopChannels();

    // "broken" never started, so its stop() must not run - only the two
    // that actually started are torn down.
    expect(stopped.sort()).toEqual(["a", "b"]);
  });

  test("stopChannels() isolates a channel whose stop() throws synchronously", async () => {
    const stopped: string[] = [];
    const throwsChannel: Channel = {
      name: "throws",
      start: async () => {},
      stop: () => {
        throw new Error("teardown failed");
      },
    };
    const okChannel: Channel = {
      name: "ok",
      start: async () => {},
      stop: async () => {
        stopped.push("ok");
      },
    };

    const app = await createServer({ ...baseConfig(), channels: [throwsChannel, okChannel] });

    // Must not reject and must still stop the other channel.
    await app.stopChannels();
    expect(stopped).toEqual(["ok"]);
  });

  test("two servers each stop only their own channels", async () => {
    const stopped: string[] = [];
    const channel1: Channel = {
      name: "one",
      start: async () => {},
      stop: async () => {
        stopped.push("one");
      },
    };
    const channel2: Channel = {
      name: "two",
      start: async () => {},
      stop: async () => {
        stopped.push("two");
      },
    };

    const app1 = await createServer({ ...baseConfig(), channels: [channel1] });
    await createServer({ ...baseConfig(), channels: [channel2] });

    await app1.stopChannels();

    expect(stopped).toEqual(["one"]);
  });
});

describe("createServer auth secret precedence", () => {
  const originalChatterSecret = process.env.CHATTER_SECRET;

  afterEach(() => {
    if (originalChatterSecret === undefined) {
      delete process.env.CHATTER_SECRET;
    } else {
      process.env.CHATTER_SECRET = originalChatterSecret;
    }
  });

  test("config.auth.secret wins over the CHATTER_SECRET env var", async () => {
    process.env.CHATTER_SECRET = "env-provided-secret-value-here";
    const configSecret = "config-provided-secret-value-here";
    const app = await createServer({ ...baseConfig(), auth: { secret: configSecret } });

    const configKey = await new ApiKeyManager(configSecret).create();
    const envKey = await new ApiKeyManager(process.env.CHATTER_SECRET).create();

    const request = (apiKey: string) =>
      app.fetch(
        new Request("http://localhost/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": apiKey },
          body: "{}",
        }),
      );

    // Bad body ("messages" missing) fails validation with 400 only once auth
    // passes, so this proves the config secret was the one used to verify.
    expect((await request(configKey)).status).toBe(400);
    // The env secret must not verify once a config secret is set.
    expect((await request(envKey)).status).toBe(401);
  });
});

describe("createServer static assets", () => {
  test("serves the widget assets through the runtime's adapter", async () => {
    const staticDir = await mkdtemp(join(tmpdir(), "chatter-server-static-"));
    await writeFile(join(staticDir, "chatter.js"), "widget");
    await writeFile(join(staticDir, "chatter.css"), "styles");

    const app = await createServer({
      ...baseConfig(),
      features: { headless: false },
      staticDir,
      publicDir: staticDir,
    });

    const script = await app.request("/chatter.js");
    expect(script.status).toBe(200);
    expect(await script.text()).toBe("widget");
    expect((await app.request("/chatter.css")).status).toBe(200);

    await rm(staticDir, { recursive: true, force: true });
  });

  test("headless mounts no static routes and loads no adapter", async () => {
    const app = await createServer({ ...baseConfig(), staticDir: knowledgeDir });

    expect((await app.request("/chatter.js")).status).toBe(404);
    // The API is still there — headless drops files, not routes.
    expect((await app.request("/healthz")).status).toBe(200);
  });
});

describe("createServer security headers and body limits", () => {
  test("emits CSP and X-Content-Type-Options on every response", async () => {
    const app = await createServer(baseConfig());

    const res = await app.request("/healthz");

    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("rejects an oversized /api/public/chat body with 413 before auth runs", async () => {
    const app = await createServer({
      ...baseConfig(),
      server: { maxRequestBytes: 16 },
    });

    // No API key is configured on this test bot, so an undersized/absent
    // body would normally hit the 401 from requirePublicKey first — the 413
    // proves the body limit runs ahead of it in the middleware stack.
    const res = await app.request("/api/public/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "this body is well over sixteen bytes long" }),
    });

    expect(res.status).toBe(413);
    expect((await res.json()).error).toContain("too large");
  });
});

describe("createServer retriever", () => {
  test("fails fast, naming the missing config, when neither database nor retriever is set", async () => {
    const { database: _database, ...withoutDatabase } = baseConfig();

    await expect(createServer(withoutDatabase)).rejects.toThrow(
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

    let receivedDb: unknown = "not set";
    let receivedStore: unknown;
    await createServer({
      ...withoutDatabase,
      retriever,
      customRoutes: (_app, deps) => {
        receivedDb = deps.db;
        receivedStore = deps.store;
      },
    });

    // build() ran before the app was handed back, deps.store is the exact
    // retriever instance (not a VectorStore wrapping it), and deps.db was
    // never opened - no config.database means no @libsql/client connection.
    expect(built).toBe(true);
    expect(receivedStore).toBe(retriever);
    expect(receivedDb).toBeUndefined();
  });

  test("a retriever without build() boots fine - build is optional on the interface", async () => {
    const { database: _database, ...withoutDatabase } = baseConfig();
    const retriever = { query: async () => [] };

    await expect(createServer({ ...withoutDatabase, retriever })).resolves.toBeDefined();
  });

  test("database and retriever together: deps.db opens for channels/customRoutes, deps.store is the retriever", async () => {
    const retriever = { query: async () => ["custom context"] };

    let receivedDb: unknown;
    let receivedStore: unknown;
    await createServer({
      ...baseConfig(),
      retriever,
      customRoutes: (_app, deps) => {
        receivedDb = deps.db;
        receivedStore = deps.store;
      },
    });

    expect(receivedStore).toBe(retriever);
    expect(receivedDb).toBeDefined();
  });
});
