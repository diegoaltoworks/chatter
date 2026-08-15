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
 * It runs under Bun because that is the runtime this package's server surface
 * requires (`hono/bun`); Bun resolves both ESM and CJS specifiers, so both
 * conditions are genuinely exercised.
 *
 * The pure half — what the contract demands, and which parts of it the tarball
 * fails — lives in scripts/pack-exports.ts and is unit-tested there.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  collectExportEntries,
  type ExportEntry,
  type ExportsValue,
  hygieneViolations,
  loadPlan,
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

const repoRoot = resolve(import.meta.dir, "..");

interface PackageManifest {
  name: string;
  exports?: Record<string, ExportsValue>;
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

/** Install the tarball into a fresh consumer and load every subpath in it. */
function resolveInConsumer(
  workspace: string,
  pkg: PackageManifest,
  tarball: string,
  entries: ExportEntry[],
  options: { name: string; optional: boolean },
): void {
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
}

const pkg = (await Bun.file(join(repoRoot, "package.json")).json()) as PackageManifest;
const entries = collectExportEntries(pkg.name, pkg.exports);
if (entries.length === 0) throw new Error("package.json declares no exports to verify");

console.log(`Building ${pkg.name} and packing a tarball...`);
run("bun", ["run", "build"], repoRoot);

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

  console.log(`Resolving ${entries.length} subpaths with every peer installed...`);
  resolveInConsumer(workspace, pkg, tarball, entries, { name: "full", optional: true });

  console.log(`Resolving ${entries.length} subpaths with the optional peers absent...`);
  resolveInConsumer(workspace, pkg, tarball, entries, { name: "lean", optional: false });

  console.log(`\nOK: every exports key of ${pkg.name} resolves from the packed tarball.`);
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
