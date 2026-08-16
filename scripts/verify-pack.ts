/**
 * Packed-tarball contract check — `bun run test:pack`, run as its own CI job.
 *
 * Builds, `npm pack`s, installs the tarball into a throwaway consumer, and
 * then, for every key in the `exports` map, resolves the subpath under BOTH
 * `import` and `require`. A subpath whose target file no build step produces
 * is invisible to `bun run check` (tsc reads the `types` condition, which is
 * emitted) and to any test that imports from `src/` — only a real consumer
 * installing a real tarball sees the MODULE_NOT_FOUND.
 *
 * That resolve pass runs under Bun, because that is the runtime this
 * package's server surface requires (`hono/bun`); Bun resolves both ESM and
 * CJS specifiers, so both conditions are genuinely exercised. The boot check
 * below is the deliberate exception — see scripts/boot-check.mjs's docstring
 * for why it has to run under real Node instead.
 *
 * The pure half — what the contract demands, and which parts of it the tarball
 * fails — lives in scripts/pack-exports.ts and is unit-tested there.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  BUNDLE_BUDGETS,
  bundleSizeViolations,
  collectExportEntries,
  type ExportEntry,
  type ExportsValue,
  hygieneViolations,
  loadPlan,
  missingBinTargets,
  missingTargets,
} from "./pack-exports";

/**
 * Runs inside the consumer, where the package sits in node_modules and
 * specifiers resolve the way a real dependant's would. Which conditions each
 * subpath is loaded under is decided by `loadPlan` and shipped in the JSON
 * alongside, so this stays a dumb executor of that plan.
 */
const RESOLVER = `import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const entries = JSON.parse(readFileSync(new URL("./exports.json", import.meta.url), "utf8"));
const failures = [];
let loaded = 0;

for (const { specifier, load } of entries) {
  if (load.import) {
    try {
      await import(specifier);
      loaded++;
    } catch (error) {
      failures.push(\`import("\${specifier}"): \${error.message}\`);
    }
  }
  if (load.require) {
    try {
      require(specifier);
      loaded++;
    } catch (error) {
      failures.push(\`require("\${specifier}"): \${error.message}\`);
    }
  }
}

if (failures.length > 0) {
  console.error("Unresolvable exports:\\n  " + failures.join("\\n  "));
  process.exit(1);
}
console.log(\`Loaded \${loaded} specifiers across \${entries.length} subpaths.\`);
`;

/**
 * The shared boot-check logic itself (scripts/boot-check.mjs) is copied
 * verbatim into each consumer — see its own docstring for why the check
 * exists and why it has to run under real Node, not Bun. This is the tiny
 * runner around it: read what this consumer expects, call it, report.
 */
const RUN_BOOT_CHECK = `import { readFileSync } from "node:fs";
import { runBootCheck } from "./boot-check.mjs";

const spec = JSON.parse(readFileSync(new URL("./boot-expect.json", import.meta.url), "utf8"));
const { createServer } = await import(spec.specifier);

try {
  await runBootCheck(createServer, spec);
  console.log(\`OK: \${spec.label}\`);
} catch (error) {
  console.error(\`FAIL: \${error.message}\`);
  process.exit(1);
}
`;

const BOOT_CHECK_SOURCE = readFileSync(join(import.meta.dir, "boot-check.mjs"), "utf8");

const repoRoot = resolve(import.meta.dir, "..");

interface PackageManifest {
  name: string;
  exports?: Record<string, ExportsValue>;
  bin?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  devDependencies?: Record<string, string>;
}

function run(command: string, args: string[], cwd: string, timeout?: number): string {
  const result = spawnSync(command, args, {
    cwd,
    timeout,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  const label = `${command} ${args.join(" ")}`;
  if (result.signal) {
    throw new Error(`${label} was killed (${result.signal}) — timed out after ${timeout}ms`);
  }
  if (result.status !== 0) {
    throw new Error(`${label} failed with status ${result.status}`);
  }
  return result.stdout;
}

/**
 * Pin every peer to the version this repo tests against, so a resolution
 * failure means our exports are wrong rather than a consumer's tree being odd.
 *
 * `optional: false` omits the peers marked optional, which is the install a
 * consumer who wants none of the heavy integrations actually gets. Every
 * subpath still has to load in that tree — the optional peers are reached
 * through dynamic imports at call time, so a static import creeping into one
 * of those modules breaks consumers who never asked for it.
 */
function consumerDependencies(
  pkg: PackageManifest,
  tarball: string,
  { optional }: { optional: boolean },
): Record<string, string> {
  const deps: Record<string, string> = { [pkg.name]: `file:${tarball}` };
  for (const [name, range] of Object.entries(pkg.peerDependencies ?? {})) {
    if (!optional && pkg.peerDependenciesMeta?.[name]?.optional) continue;
    deps[name] = pkg.devDependencies?.[name] ?? range;
  }
  return deps;
}

/** What runBootCheck (scripts/boot-check.mjs) asserts, computed per consumer by the two call sites below. */
interface BootCheckSpec {
  chatterJsStatus: number;
  expectActionableLog: boolean;
  label: string;
}

/** Install the tarball into a fresh consumer and load every subpath in it. Returns the consumer's directory. */
function resolveInConsumer(
  workspace: string,
  pkg: PackageManifest,
  tarball: string,
  entries: ExportEntry[],
  options: { name: string; optional: boolean; bootCheck: BootCheckSpec },
): string {
  const consumer = join(workspace, options.name);
  mkdirSync(consumer, { recursive: true });
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({
      name: `pack-consumer-${options.name}`,
      private: true,
      dependencies: consumerDependencies(pkg, tarball, { optional: options.optional }),
    }),
  );
  run("bun", ["install"], consumer);

  writeFileSync(join(consumer, "resolve-exports.mjs"), RESOLVER);
  writeFileSync(
    join(consumer, "exports.json"),
    JSON.stringify(entries.map((entry) => ({ ...entry, load: loadPlan(entry) }))),
  );
  // Bounded: importing the package must not leave a handle on the consumer's
  // event loop, so the resolver exiting on its own is part of what we check.
  // Without the bound, such a regression hangs the CI job instead of failing.
  run("bun", ["run", "resolve-exports.mjs"], consumer, 120_000);

  writeFileSync(join(consumer, "boot-check.mjs"), BOOT_CHECK_SOURCE);
  writeFileSync(join(consumer, "run-boot-check.mjs"), RUN_BOOT_CHECK);
  writeFileSync(
    join(consumer, "boot-expect.json"),
    JSON.stringify({ specifier: pkg.name, ...options.bootCheck }),
  );
  // Real `node`, not `bun run` — see scripts/boot-check.mjs's docstring for why.
  run("node", ["run-boot-check.mjs"], consumer, 30_000);

  return consumer;
}

/**
 * Runs every declared bin with `--help` from inside a consumer that has the
 * package installed, the way `npx <bin>` would. Bins sit outside `exports`,
 * so nothing above this notices one pointing at a build artefact that was
 * never produced, or one that throws before it ever prints its usage text.
 *
 * `chatter` requires jose, an ESM-only dependency, from CJS — that needs
 * Node's `require(esm)` support (unflagged since 22.12, below this package's
 * own engines floor, so CI is unaffected). A developer on an older local Node
 * still gets every other check in this file instead of an opaque
 * ERR_REQUIRE_ESM. Mirrors the same guard in scripts/verify-node.mjs.
 */
function smokeTestBins(consumer: string, pkg: PackageManifest): void {
  const [nodeMajor, nodeMinor] = run("node", ["-p", "process.versions.node"], consumer)
    .trim()
    .split(".")
    .map(Number);
  const requiresEsmSupported = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 12);
  if (!requiresEsmSupported) {
    console.log(`  skip bin smoke test — Node ${nodeMajor}.${nodeMinor} has no require(esm)`);
    return;
  }

  for (const [name, target] of Object.entries(pkg.bin ?? {})) {
    const binPath = join(consumer, "node_modules", ".bin", name);
    const output = run("node", [binPath, "--help"], consumer, 15_000);
    if (!output.includes("Usage")) {
      throw new Error(`bin "${name}" (${target}) did not print usage text for --help:\n${output}`);
    }
  }
}

const pkg = (await Bun.file(join(repoRoot, "package.json")).json()) as PackageManifest;
const entries = collectExportEntries(pkg.name, pkg.exports);
if (entries.length === 0) throw new Error("package.json declares no exports to verify");

console.log(`Building ${pkg.name} and packing a tarball...`);
run("bun", ["run", "build"], repoRoot);

const sizes = new Map(
  BUNDLE_BUDGETS.map(({ path }) => [path, statSync(join(repoRoot, path)).size]),
);
const oversized = bundleSizeViolations(BUNDLE_BUDGETS, sizes);
if (oversized.length > 0) {
  const lines = oversized.map(
    (v) => `${v.path}: ${v.actualBytes} bytes exceeds budget of ${v.maxBytes} bytes`,
  );
  throw new Error(`root bundle exceeds its size budget:\n  ${lines.join("\n  ")}`);
}
console.log(
  `Root bundle within budget: ${[...sizes].map(([path, size]) => `${path} (${size}b)`).join(", ")}`,
);

const workspace = mkdtempSync(join(tmpdir(), "chatter-pack-"));
try {
  const packed = JSON.parse(
    run("npm", ["pack", "--json", "--pack-destination", workspace], repoRoot),
  );
  const tarball = join(workspace, packed[0].filename);
  const files: string[] = packed[0].files.map((file: { path: string }) => file.path);

  const stowaways = hygieneViolations(files);
  if (stowaways.length > 0) {
    throw new Error(`tarball ships test/fixture artefacts:\n  ${stowaways.join("\n  ")}`);
  }

  const missing = missingTargets(entries, files);
  if (missing.length > 0) {
    const lines = missing.map((v) => `${v.subpath} (${v.condition}) -> ${v.target}`);
    throw new Error(
      `exports point at files the tarball does not contain:\n  ${lines.join("\n  ")}`,
    );
  }

  const missingBins = missingBinTargets(pkg.bin, files);
  if (missingBins.length > 0) {
    throw new Error(
      `bin entries point at files the tarball does not contain:\n  ${missingBins.join("\n  ")}`,
    );
  }

  console.log(`Resolving ${entries.length} subpaths with every peer installed...`);
  const fullConsumer = resolveInConsumer(workspace, pkg, tarball, entries, {
    name: "full",
    optional: true,
    bootCheck: {
      chatterJsStatus: 200,
      expectActionableLog: false,
      label: "chatter.js is served automatically when @hono/node-server is installed",
    },
  });

  console.log("Smoke-testing bins from the tarball...");
  smokeTestBins(fullConsumer, pkg);

  console.log(`Resolving ${entries.length} subpaths with the optional peers absent...`);
  resolveInConsumer(workspace, pkg, tarball, entries, {
    name: "lean",
    optional: false,
    bootCheck: {
      chatterJsStatus: 404,
      expectActionableLog: true,
      label:
        "chatter.js absence without @hono/node-server is a logged, actionable error, not a silent 404",
    },
  });

  console.log(`\nOK: every exports key of ${pkg.name} resolves from the packed tarball.`);
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
