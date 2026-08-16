/**
 * Pure logic behind the supply-chain audit (`bun test scripts/supply-chain`).
 *
 * The path from an upstream dependency to npm is otherwise fully automated:
 * dependabot opens a PR, auto-merge lands it on `main`, CI goes green, and the
 * publish workflow cuts a release. Five properties keep that path from being a
 * zero-human path to the registry, and each one is a line or two in a config
 * file that nothing else would notice going missing:
 *
 *   1. Every third-party action is pinned to a full commit SHA, so a moved tag
 *      cannot swap the code running in a workflow that holds publish rights.
 *   2. Bun is pinned to one exact version everywhere — workflows and the
 *      Dockerfile alike — so the toolchain the gates ran under is the
 *      toolchain that builds the tarball.
 *   3. Installs use `--frozen-lockfile`, so CI resolves the committed lockfile
 *      rather than whatever the registry offers that minute.
 *   4. Publishing refuses any release range in which dependabot changed
 *      something that runs, so such a change reaches npm only when a human
 *      dispatches the release.
 *   5. The publish workflow verifies the artifact itself — the dispatch path,
 *      which is how a reviewed bump ships, never passes through CI.
 *
 * These helpers turn config file contents into a list of violations. They are
 * deliberately line-based rather than a YAML parse: the properties are all
 * lexical, and a parser would add a dependency to assert something a regex can
 * see. scripts/supply-chain.test.ts feeds them fixtures and the real files.
 *
 * Every check ignores commented-out lines. Otherwise a guard could be deleted
 * and left behind as prose, and the audit would keep passing on the corpse.
 */

/** A `uses:` reference in a workflow, with the version comment beside it. */
export interface ActionUse {
  /** Workflow file the reference came from, e.g. "ci.yml". */
  file: string;
  /** 1-indexed line number, so a violation points somewhere. */
  line: number;
  /** Owner/repo (plus any subpath), e.g. "actions/checkout". */
  action: string;
  /** Whatever follows the `@`: a tag, branch, or commit SHA. */
  ref: string;
  /** Trailing `# v7.0.1` comment, which is how dependabot tracks a pin. */
  comment?: string;
}

/** Something in a config file that weakens the chain, with a note on why. */
export interface SupplyChainViolation {
  file: string;
  line: number;
  reason: string;
}

const USES = /^\s*(?:-\s+)?uses:\s*["']?([^"'\s]+)["']?\s*(?:#\s*(.*?)\s*)?$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const EXACT_SEMVER = /^\d+\.\d+\.\d+$/;
/** `bun install`, and the aliases that reach a registry just as happily. */
const BUN_INSTALL = /\bbun\s+(?:install|i|add|update)\b/;
const DOCKER_BUN_IMAGE = /^\s*FROM\s+oven\/bun:(\S+)/;

/** Is this line commented out? A commented guard is not a guard. */
function isComment(text: string): boolean {
  return /^\s*#/.test(text);
}

/** Does any live (uncommented) line match? */
function hasLiveMatch(contents: string, pattern: RegExp): boolean {
  return contents.split("\n").some((text) => !isComment(text) && pattern.test(text));
}

/** Actions resolved from the local checkout are audited as repo code instead. */
function isThirdParty(action: string): boolean {
  return !action.startsWith("./") && !action.startsWith("docker://");
}

/** Collect every `uses:` line in one workflow file. */
export function parseActionUses(file: string, contents: string): ActionUse[] {
  const uses: ActionUse[] = [];

  contents.split("\n").forEach((text, index) => {
    if (isComment(text)) return;
    const match = USES.exec(text);
    if (!match?.[1]) return;

    const [action, ref = ""] = splitRef(match[1]);
    uses.push({ file, line: index + 1, action, ref, ...(match[2] ? { comment: match[2] } : {}) });
  });

  return uses;
}

/** Split `owner/repo@ref` on the last `@`, so scoped subpaths survive. */
function splitRef(reference: string): [string, string?] {
  const at = reference.lastIndexOf("@");
  return at === -1 ? [reference] : [reference.slice(0, at), reference.slice(at + 1)];
}

/**
 * Third-party actions that are not pinned to a commit SHA, or that are pinned
 * without the version comment dependabot needs to offer an update. An unpinned
 * action is the hole; an uncommented pin is the pin quietly rotting shut.
 */
export function unpinnedActions(uses: ActionUse[]): SupplyChainViolation[] {
  return uses
    .filter((use) => isThirdParty(use.action))
    .flatMap(({ file, line, action, ref, comment }) => {
      if (!COMMIT_SHA.test(ref)) {
        return [{ file, line, reason: `${action} is pinned to "${ref}", not a commit SHA` }];
      }
      if (!comment) {
        return [{ file, line, reason: `${action} pin has no version comment for dependabot` }];
      }
      return [];
    });
}

/**
 * Install commands that may resolve something other than the committed
 * lockfile. Anything with `--frozen-lockfile` passes; a bare `bun install` — or
 * an `i`/`add`/`update` that rewrites the lockfile mid-run — does not.
 */
export function unfrozenInstalls(file: string, contents: string): SupplyChainViolation[] {
  const violations: SupplyChainViolation[] = [];

  contents.split("\n").forEach((text, index) => {
    if (isComment(text)) return;
    if (!BUN_INSTALL.test(text)) return;
    if (text.includes("--frozen-lockfile")) return;
    violations.push({ file, line: index + 1, reason: "install without --frozen-lockfile" });
  });

  return violations;
}

/**
 * Bun toolchain selections that float. `latest` and `canary` mean the toolchain
 * that builds a release is whatever shipped that morning; a major/minor range
 * is the same problem with a smaller blast radius. `bun-version-file` is
 * rejected outright — it would move the pin somewhere this audit cannot see.
 */
export function floatingBunVersions(file: string, contents: string): SupplyChainViolation[] {
  const violations: SupplyChainViolation[] = [];

  contents.split("\n").forEach((text, index) => {
    if (isComment(text)) return;

    if (/^\s*bun-version-file:/.test(text)) {
      violations.push({
        file,
        line: index + 1,
        reason: "bun-version-file hides the pin from this audit",
      });
      return;
    }

    const match = /^\s*bun-version:\s*["']?([^"'\s#]+)/.exec(text);
    if (!match?.[1]) return;
    if (EXACT_SEMVER.test(match[1])) return;
    violations.push({
      file,
      line: index + 1,
      reason: `bun-version "${match[1]}" is not an exact version`,
    });
  });

  return violations;
}

/** Every exact Bun version a workflow asks setup-bun for. */
export function workflowBunVersions(contents: string): string[] {
  return contents
    .split("\n")
    .filter((text) => !isComment(text))
    .flatMap((text) => /^\s*bun-version:\s*["']?([^"'\s#]+)/.exec(text)?.[1] ?? []);
}

/** Every Bun version a Dockerfile builds on, with any `-slim` variant dropped. */
export function dockerBunVersions(contents: string): string[] {
  return contents
    .split("\n")
    .filter((text) => !isComment(text))
    .flatMap((text) => DOCKER_BUN_IMAGE.exec(text)?.[1]?.replace(/-.*$/, "") ?? []);
}

/**
 * The workflows and the Dockerfile must name the same Bun. They drift for a
 * mundane reason: dependabot's docker ecosystem bumps the base image and
 * nothing bumps the workflows, so the image that builds the artifact quietly
 * stops being the one the gates ran under.
 */
export function toolchainDrift(versions: readonly string[]): SupplyChainViolation[] {
  const distinct = [...new Set(versions)];
  if (distinct.length <= 1) return [];

  return [
    {
      file: "Dockerfile",
      line: 1,
      reason: `Bun is pinned to more than one version across CI and the image: ${distinct.join(", ")}`,
    },
  ];
}

/** Does this workflow push a tarball to the registry? */
export function publishesToNpm(contents: string): boolean {
  return hasLiveMatch(contents, /\bnpm publish\b/);
}

/**
 * A publishing workflow must refuse to release a range containing an
 * unreviewed dependabot-authored change. Two guards, because they fail
 * differently:
 *
 * - The job condition declines the run when dependabot authored the *tip*,
 *   which is the auto-merge case and costs nothing to check.
 * - A step that scans every commit since the last release tag catches the
 *   change riding along inside somebody else's later release — the tip guard
 *   sees only one commit, and the change is not it.
 *
 * Both are bypassed by `workflow_dispatch`, which is the point: dispatching is
 * a human putting their name on the dependency change. The scan itself lives
 * in scripts/release-guard.ts, which is what decides a manifest-only bump may
 * ride along; an inline `git log … | grep` is still accepted here, since what
 * this audit is protecting is that *something* reads the range.
 */
export function missingDependabotGate(file: string, contents: string): SupplyChainViolation[] {
  const guardsTip = hasLiveMatch(contents, /head_commit\.author\.name\s*!=\s*'dependabot\[bot\]'/);
  const guardsRange =
    hasLiveMatch(contents, /\brelease-guard\.ts\b/) ||
    (hasLiveMatch(contents, /\bgit log\b/) &&
      hasLiveMatch(contents, /grep[^\n]*dependabot\[bot\]/));

  const missing = [
    ...(guardsTip ? [] : ["the job condition does not reject a dependabot-authored head commit"]),
    ...(guardsRange ? [] : ["no step scans the unreleased range for dependabot-authored commits"]),
  ];

  return missing.map((reason) => ({ file, line: 1, reason }));
}

/** Artifact checks a publishing workflow must run itself, and why. */
const RELEASE_VERIFICATION: ReadonlyArray<[script: string, reason: string]> = [
  ["test:pack", "the packed tarball's exports are never resolved before publishing"],
  ["test:node", "the built package is never loaded under Node before publishing"],
];

/**
 * A publishing workflow must verify the artifact itself, not lean on CI having
 * done it. `workflow_dispatch` is a real release path — it is the one used to
 * ship a reviewed dependency bump — and it does not pass through CI at all, so
 * anything only CI runs is absent from exactly the release nobody reviewed
 * upstream.
 */
export function missingReleaseVerification(file: string, contents: string): SupplyChainViolation[] {
  return RELEASE_VERIFICATION.filter(
    ([script]) => !hasLiveMatch(contents, new RegExp(`\\b${script}\\b`)),
  ).map(([, reason]) => ({ file, line: 1, reason }));
}

/** Every violation in one workflow file, in the order they appear. */
export function auditWorkflow(file: string, contents: string): SupplyChainViolation[] {
  const violations = [
    ...unpinnedActions(parseActionUses(file, contents)),
    ...unfrozenInstalls(file, contents),
    ...floatingBunVersions(file, contents),
    ...(publishesToNpm(contents)
      ? [...missingDependabotGate(file, contents), ...missingReleaseVerification(file, contents)]
      : []),
  ];

  return violations.sort((a, b) => a.line - b.line);
}
