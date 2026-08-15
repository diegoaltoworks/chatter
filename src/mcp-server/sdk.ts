/**
 * The one place `./mcp` touches `@modelcontextprotocol/sdk` and `zod` at
 * runtime. Both are OPTIONAL peer dependencies — `bun install` and every core
 * import must work without them — so `mcp-server.ts` may not `import` either
 * statically; it takes the MCP server constructor and the zod runtime as
 * values loaded here, and reaches their types separately via a type-only
 * import (erased at compile time, so it costs nothing at runtime).
 *
 * `loadMcpSdk()`/`loadZod()` are the single dynamic imports, called lazily
 * when an MCP server actually starts, so a missing package fails with an
 * actionable message instead of a raw "Cannot find module" — or, worse, at
 * unrelated core imports that never touch MCP at all.
 */

type McpSdkModule = typeof import("@modelcontextprotocol/sdk/server/mcp.js");
type ZodModule = typeof import("zod");

export type McpServerCtor = McpSdkModule["McpServer"];
export type Zod = ZodModule["z"];

/** Wraps a failed dynamic import of an optional MCP peer in an actionable message. Exported separately so the message content is unit-testable without simulating a real missing module. */
export function wrapMissingMcpPeerError(packageName: string, cause: unknown): Error {
  return new Error(
    `The MCP server ('@diegoaltoworks/chatter/mcp') requires the optional peer dependency ` +
      `'${packageName}', which is not installed. Install it with \`bun add ${packageName}\` ` +
      "(or npm/pnpm/yarn) to use this feature.",
    { cause },
  );
}

let cachedSdk: Promise<McpServerCtor> | undefined;

export function loadMcpSdk(): Promise<McpServerCtor> {
  if (!cachedSdk) {
    cachedSdk = import("@modelcontextprotocol/sdk/server/mcp.js")
      .then((mod) => {
        if (!mod.McpServer) throw new Error("module has no McpServer export");
        return mod.McpServer;
      })
      .catch((error) => {
        cachedSdk = undefined;
        throw wrapMissingMcpPeerError("@modelcontextprotocol/sdk", error);
      });
  }
  return cachedSdk;
}

let cachedZod: Promise<Zod> | undefined;

export function loadZod(): Promise<Zod> {
  if (!cachedZod) {
    cachedZod = import("zod")
      .then((mod) => {
        if (!mod.z) throw new Error("module has no z export");
        return mod.z;
      })
      .catch((error) => {
        cachedZod = undefined;
        throw wrapMissingMcpPeerError("zod", error);
      });
  }
  return cachedZod;
}
