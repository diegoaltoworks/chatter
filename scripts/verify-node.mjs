/**
 * Node runtime contract check — `bun run build && bun run test:node`, run as
 * its own CI job under plain Node.
 *
 * `bun run check` proves nothing about Node: it executes every test under Bun,
 * where a `Bun` global exists and `require()` works inside ESM. Both of those
 * hid real breakage in the published bundles — a static `hono/bun` import that
 * threw "Bun is not defined" on `import('.../server.mjs')`, and an esbuild
 * `__require` shim in ESM output. This script runs the built artefacts the way
 * a Node consumer loads them, so those regressions fail a job instead of a
 * user's install.
 *
 * Deliberately plain `.mjs`: it must be runnable by `node` with no loader.
 */

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runBootCheck } from "./boot-check.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(repoRoot, "dist");
const require = createRequire(import.meta.url);

const failures = [];

async function check(name, run) {
  try {
    await run();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
    console.error(`  FAIL ${name}: ${error.stack ?? error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

console.log(`Verifying dist/ under Node ${process.version}\n`);

// A require() left in an ESM bundle throws "Dynamic require of X is not
// supported" the moment that line runs. esbuild rewrites the call to
// `__require` behind a shim it only emits when such a call survives, so the
// shim's declaration is the reliable tell — grepping for `require(` is not
// (the shim itself never writes one).
await check("ESM bundles carry no dynamic-require shim", async () => {
  const entries = ["index.mjs", "server.mjs", "mcp-server.mjs"];
  for (const entry of entries) {
    const source = await readFile(join(dist, entry), "utf8");
    // The shim declaration, not the call sites: bundled dependencies emit
    // `require(...)` inside string literals (ajv generates code), so grepping
    // for the text of a call is all false positives.
    assert(
      !/\bvar __require\s*=/.test(source),
      `dist/${entry} carries esbuild's dynamic-require shim`,
    );
  }
});

await check("import('dist/index.mjs') exposes the public API", async () => {
  const module = await import(new URL("./dist/index.mjs", `file://${repoRoot}/`));
  for (const name of ["createServer", "prepareChat", "answerOnce", "ApiKeyManager"]) {
    assert(typeof module[name] === "function", `missing export ${name}`);
  }
});

// The CJS bundle pulls in ESM-only dependencies (jose), so `require()`ing it
// needs Node's require(esm) support — unflagged since 22.12, and well below
// this package's engines floor. CI runs the supported floor; a developer on an
// older Node still gets every other check.
const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
const requiresEsmSupported = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 12);

if (requiresEsmSupported) {
  await check("require('dist/index.js') exposes the public API", () => {
    const module = require(join(dist, "index.js"));
    assert(typeof module.createServer === "function", "missing export createServer");
  });
} else {
  console.log(`  skip require('dist/index.js') — Node ${process.version} has no require(esm)`);
}

await check("import('dist/server.mjs') does not need a Bun global", async () => {
  assert(globalThis.Bun === undefined, "this check is meaningless outside plain Node");
  const module = await import(new URL("./dist/server.mjs", `file://${repoRoot}/`));
  assert(typeof module.createServer === "function", "missing export createServer");
});

// The Node static adapter, end to end: boots the real factory the way a Node
// host does and asserts the actual built widget is served — not a synthetic
// stand-in. In-memory libsql and an empty knowledge directory keep it
// offline: with nothing to embed, the vector store never calls OpenAI. See
// scripts/boot-check.mjs, shared verbatim with the packed-tarball check.
await check("createServer boots and serves under Node", async () => {
  const { createServer } = await import(new URL("./dist/index.mjs", `file://${repoRoot}/`));
  await runBootCheck(createServer, { chatterJsStatus: 200, expectActionableLog: false });
});

if (failures.length > 0) {
  console.error(`\nNode runtime contract broken:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log("\nOK: the built package loads and serves under plain Node.");
