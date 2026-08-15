/**
 * Static-adapter seam tests.
 *
 * Both adapters are exercised from the same runtime: the Node one is pure
 * `node:fs` + web streams, so Bun can load and run it. That is the point —
 * the Node path is verified on every `bun run check`, not only in the CI job
 * that runs the built package under Node.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Hono } from "hono";
import {
  detectRuntime,
  loadServeStatic,
  STATIC_ADAPTERS,
  type StaticRuntime,
  wrapMissingAdapterError,
} from "./serve-static";

const BODY = "console.log('chatter');\n";

let assetDir: string;
let assetPath: string;

beforeAll(async () => {
  assetDir = await mkdtemp(join(tmpdir(), "chatter-static-"));
  await writeFile(join(assetDir, "chatter.js"), BODY);
  // The server passes cwd-relative paths, which is what both adapters resolve
  // against; keep the test on that same contract.
  assetPath = `${relative(process.cwd(), assetDir)}/chatter.js`;
});

afterAll(async () => {
  await rm(assetDir, { recursive: true, force: true });
});

describe("detectRuntime", () => {
  test("reports bun when the Bun global is present", () => {
    expect(detectRuntime()).toBe("bun");
  });

  test("maps every runtime to an adapter specifier", () => {
    expect(STATIC_ADAPTERS).toEqual({
      bun: "hono/bun",
      node: "@hono/node-server/serve-static",
    });
  });
});

describe("loadServeStatic", () => {
  for (const runtime of ["bun", "node"] as StaticRuntime[]) {
    test(`the ${runtime} adapter serves a file the server would mount`, async () => {
      const serveStatic = await loadServeStatic(runtime);
      const app = new Hono();
      app.get("/chatter.js", serveStatic({ path: assetPath }));

      const response = await app.request("/chatter.js");

      expect(response.status).toBe(200);
      expect(await response.text()).toBe(BODY);
    });

    test(`the ${runtime} adapter falls through to the next handler for a missing file`, async () => {
      const serveStatic = await loadServeStatic(runtime);
      const app = new Hono();
      app.get("/gone.js", serveStatic({ path: `${assetDir}/nope.js` }));
      app.get("/gone.js", (c) => c.text("fallthrough", 404));

      const response = await app.request("/gone.js");

      expect(response.status).toBe(404);
      expect(await response.text()).toBe("fallthrough");
    });
  }

  test("memoises per runtime so a server mounting several routes imports once", async () => {
    expect(loadServeStatic("node")).toBe(loadServeStatic("node"));
    expect(await loadServeStatic("node")).not.toBe(await loadServeStatic("bun"));
  });

  test("defaults to the detected runtime", async () => {
    expect(await loadServeStatic()).toBe(await loadServeStatic(detectRuntime()));
  });
});

describe("wrapMissingAdapterError", () => {
  test("names the missing package and how to install it, keeping the cause", () => {
    const cause = new Error("Cannot find module '@hono/node-server/serve-static'");

    const error = wrapMissingAdapterError("node", cause);

    expect(error.message).toContain("@hono/node-server/serve-static");
    expect(error.message).toContain("npm install @hono/node-server");
    expect(error.message).toContain("headless");
    expect(error.cause).toBe(cause);
  });

  test("points Bun users at their hono install rather than an optional peer", () => {
    const error = wrapMissingAdapterError("bun", new Error("boom"));

    expect(error.message).toContain("hono/bun");
    expect(error.message).not.toContain("npm install");
  });
});
