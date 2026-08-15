/**
 * The one place the server touches a runtime-specific static-file adapter.
 *
 * `hono/bun`'s `serveStatic` reads the `Bun` global at import time, so a static
 * `import` of it makes the whole package Bun-only: `import("./dist/server.mjs")`
 * under Node throws "Bun is not defined" before a single route is mounted, even
 * in headless mode where no file is ever served. This module keeps both
 * adapters behind lazy, literal dynamic imports and picks one from the runtime
 * actually executing, so the import graph stays runtime-neutral and only a
 * server that really serves files pays for an adapter.
 *
 * Under Node the adapter is `@hono/node-server/serve-static`, an OPTIONAL peer
 * dependency: a Node consumer running headless never needs it, so a missing
 * package must not be an import-time failure.
 */

import type { MiddlewareHandler } from "hono";

/** The subset of both adapters' options this package uses. */
export interface ServeStaticOptions {
  /** File to serve, relative to `root` (which defaults to the process cwd). */
  path: string;
  root?: string;
}

export type ServeStaticFn = (options: ServeStaticOptions) => MiddlewareHandler;

/** Runtimes we have a static-file adapter for. */
export type StaticRuntime = "bun" | "node";

/** Module specifier loaded for each runtime — exported so tests can assert the mapping without importing. */
export const STATIC_ADAPTERS: Record<StaticRuntime, string> = {
  bun: "hono/bun",
  node: "@hono/node-server/serve-static",
};

/** Which adapter the current process needs. Bun exposes a `Bun` global; nothing else does. */
export function detectRuntime(): StaticRuntime {
  return typeof (globalThis as { Bun?: unknown }).Bun === "undefined" ? "node" : "bun";
}

/** Wraps a failed adapter import in an actionable message. Exported separately so the wording is unit-testable without simulating a missing module. */
export function wrapMissingAdapterError(runtime: StaticRuntime, cause: unknown): Error {
  const specifier = STATIC_ADAPTERS[runtime];
  return new Error(
    `Serving static files under ${runtime} requires '${specifier}', which could not be loaded. ` +
      (runtime === "node"
        ? "Install the optional peer dependency with `npm install @hono/node-server` (or bun/pnpm/yarn), " +
          "or run Chatter headless (`features.headless: true`) if it should serve no static assets."
        : "Upgrade 'hono' to a version that ships the Bun adapter."),
    { cause },
  );
}

const cache = new Map<StaticRuntime, Promise<ServeStaticFn>>();

/**
 * Resolve the static-file middleware factory for `runtime`, memoised per
 * runtime. A rejected load is evicted so a later call can retry (the package
 * may have been installed in between), mirroring `loadBaileys()`.
 */
export function loadServeStatic(runtime: StaticRuntime = detectRuntime()): Promise<ServeStaticFn> {
  const cached = cache.get(runtime);
  if (cached) return cached;

  // Two literal specifiers, not one computed one: bundlers can see them, and
  // both are marked external by the build so neither adapter is inlined.
  const loading = (
    runtime === "bun" ? import("hono/bun") : import("@hono/node-server/serve-static")
  ).then(
    (module) => module.serveStatic as ServeStaticFn,
    (error: unknown) => {
      cache.delete(runtime);
      throw wrapMissingAdapterError(runtime, error);
    },
  );

  cache.set(runtime, loading);
  return loading;
}
