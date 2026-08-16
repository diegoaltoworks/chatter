/**
 * Pure logic behind the packed-tarball contract check (`bun run test:pack`).
 *
 * The published package is only as good as its `exports` map: a subpath whose
 * target file no build step produces still typechecks for consumers (the
 * `types` condition resolves against a `.d.ts` that tsc does emit) and only
 * fails at runtime with MODULE_NOT_FOUND. These helpers turn the declared
 * contract plus the actual tarball contents into a list of violations, so the
 * check is deterministic and unit-testable without building or packing.
 *
 * scripts/verify-pack.ts is the impure half: it builds, packs, installs the
 * tarball, and feeds the results in here.
 */

/** The conditions we hold the package to. `default` is folded into both. */
export type ExportCondition = "types" | "import" | "require";

export interface ExportEntry {
  /** Subpath as written in `exports`, e.g. "." or "./whatsapp". */
  subpath: string;
  /** What a consumer writes: "@scope/pkg" or "@scope/pkg/whatsapp". */
  specifier: string;
  /** Package-relative target per condition, e.g. "./dist/index.mjs". */
  targets: Partial<Record<ExportCondition, string>>;
}

export interface ContractViolation {
  subpath: string;
  condition: ExportCondition;
  /** The declared target that is absent from the tarball. */
  target: string;
}

/** A node in a package.json `exports` map: a target path or a condition set. */
export type ExportsValue = string | { [condition: string]: ExportsValue } | null;

/**
 * Flatten a package.json `exports` map into one entry per subpath.
 *
 * A string value (`"./package.json": "./package.json"`) is the shorthand for
 * every condition, so it counts as both `import` and `require`. Nested
 * condition objects are read one level deep — the shape this package uses —
 * with `default` filling in whichever of import/require is not spelled out.
 */
export function collectExportEntries(
  packageName: string,
  exportsMap: Record<string, ExportsValue> | undefined,
): ExportEntry[] {
  if (!exportsMap) return [];

  return Object.entries(exportsMap).map(([subpath, value]) => {
    const targets: Partial<Record<ExportCondition, string>> = {};

    if (typeof value === "string") {
      targets.import = value;
      targets.require = value;
    } else if (value && typeof value === "object") {
      const conditions = value as Record<string, ExportsValue>;
      const fallback = typeof conditions.default === "string" ? conditions.default : undefined;
      for (const condition of ["types", "import", "require"] as const) {
        const declared = conditions[condition];
        const target =
          typeof declared === "string" ? declared : condition === "types" ? undefined : fallback;
        if (target) targets[condition] = target;
      }
    }

    return { subpath, specifier: specifierFor(packageName, subpath), targets };
  });
}

/** Which module systems a subpath can be *loaded* under, not merely resolved. */
export interface LoadPlan {
  import: boolean;
  require: boolean;
}

/**
 * Not every exports key is a module. An asset subpath (`./client/style.css`)
 * has no meaning to `import`/`require` outside a bundler, and JSON needs an
 * import attribute under ESM — a property of the consumer's syntax rather than
 * of our contract, so JSON is checked by `require` alone. For those keys the
 * contract we can honestly assert is that the packed file exists, which
 * `missingTargets` already covers; only JS targets get loaded.
 */
export function loadPlan(entry: ExportEntry): LoadPlan {
  const isScript = (target?: string) => /\.(m|c)?js$/.test(target ?? "");
  const isJson = (target?: string) => (target ?? "").endsWith(".json");

  return {
    import: isScript(entry.targets.import),
    require: isScript(entry.targets.require) || isJson(entry.targets.require),
  };
}

/** Turn a `.`/`./sub` subpath into the specifier a consumer imports. */
export function specifierFor(packageName: string, subpath: string): string {
  return subpath === "." ? packageName : `${packageName}/${subpath.replace(/^\.\//, "")}`;
}

/**
 * Every declared target that the tarball does not actually contain.
 *
 * `files` are package-relative paths (`dist/index.mjs`), i.e. `npm pack`
 * listings with their leading `package/` stripped.
 */
export function missingTargets(
  entries: ExportEntry[],
  files: readonly string[],
): ContractViolation[] {
  const present = new Set(files.map(normalizePath));
  const violations: ContractViolation[] = [];

  for (const entry of entries) {
    for (const [condition, target] of Object.entries(entry.targets)) {
      if (!present.has(normalizePath(target))) {
        violations.push({
          subpath: entry.subpath,
          condition: condition as ExportCondition,
          target,
        });
      }
    }
  }

  return violations;
}

/**
 * Bins are not part of `exports`, so `missingTargets` never sees them: a
 * `package.json#bin` entry pointing at a file `build:bin` stopped producing
 * would ship silently and only fail once someone runs `npx <bin>`. Same
 * shape of check as `missingTargets`, one condition (bins are CJS, run
 * directly by Node) instead of three.
 */
export function missingBinTargets(
  bin: Record<string, string> | undefined,
  files: readonly string[],
): string[] {
  const present = new Set(files.map(normalizePath));
  return Object.entries(bin ?? {})
    .filter(([, target]) => !present.has(normalizePath(target)))
    .map(([name, target]) => `${name} -> ${target}`);
}

/**
 * Build artefacts that must never ship: declarations for test files, and
 * anything under a `__fixtures__` directory. Both are authored under `src/`
 * and so land in `dist` unless declaration emit excludes them.
 */
export function hygieneViolations(files: readonly string[]): string[] {
  return files
    .map(normalizePath)
    .filter(
      (file) => /\.test\.d\.ts(\.map)?$/.test(file) || file.split("/").includes("__fixtures__"),
    );
}

/** Strip `package/` and `./` prefixes so declared and packed paths compare equal. */
function normalizePath(path: string): string {
  return path.replace(/^package\//, "").replace(/^\.\//, "");
}

/**
 * Root-entry size budgets, in bytes. The root bundle (`.`) is what every
 * consumer's install size includes regardless of which subpaths they touch,
 * so it is held to a budget the way the tarball contract is — a regression
 * here (an optional peer or the widget creeping back into a static import)
 * is invisible to typecheck/lint/test and only shows up as install bloat.
 */
export const BUNDLE_BUDGETS: readonly { path: string; maxBytes: number }[] = [
  { path: "dist/index.mjs", maxBytes: 100 * 1024 },
  { path: "dist/index.js", maxBytes: 100 * 1024 },
];

export interface BundleSizeViolation {
  path: string;
  maxBytes: number;
  actualBytes: number;
}

/** Which budgeted paths exceed their limit. Throws if a budgeted path has no recorded size — a missing entry is a broken check, not a pass. */
export function bundleSizeViolations(
  budgets: readonly { path: string; maxBytes: number }[],
  sizes: ReadonlyMap<string, number>,
): BundleSizeViolation[] {
  return budgets.flatMap((budget) => {
    const actualBytes = sizes.get(budget.path);
    if (actualBytes === undefined) {
      throw new Error(`no size recorded for budgeted path "${budget.path}"`);
    }
    return actualBytes > budget.maxBytes
      ? [{ path: budget.path, maxBytes: budget.maxBytes, actualBytes }]
      : [];
  });
}
