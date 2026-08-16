/**
 * The gate between an unreviewed dependency bump and npm — `bun scripts/release-guard.ts`,
 * run by the publish workflow before it builds anything.
 *
 * The rule it enforces is narrow: nothing an upstream maintainer wrote reaches
 * the registry under our name without a human having read it. The previous
 * shape of this gate — fail if `dependabot[bot]` authored *anything* since the
 * last release tag — enforced that rule and deadlocked on it. Only a
 * successful publish moves the tag, and the gate stopped every publish, so one
 * routine bump froze the release train indefinitely and every fix behind it
 * sat unshipped.
 *
 * The deadlock came from treating two different commits the same way. A bump
 * that edits only a manifest or a lockfile changes which versions this package
 * *declares*; it ships no upstream code, and the gates run against it like any
 * other commit. A bump that edits a workflow, a Dockerfile or source — the
 * github-actions and docker ecosystems both do — changes what runs, and that
 * is the case worth stopping. So only the second kind blocks, which is why the
 * common case can no longer wedge the train, and a block is always cleared by
 * one `workflow_dispatch` (a maintainer putting their name on the change),
 * which publishes and moves the tag past it.
 *
 * The pure half is exported and unit-tested in scripts/release-guard.test.ts,
 * including against the commit range that actually deadlocked.
 */

import { execFileSync } from "node:child_process";
import { basename } from "node:path";

/** `git log --format=%an` for a commit dependabot opened. */
export const DEPENDABOT_AUTHOR = "dependabot[bot]";

/**
 * Files whose contents are a dependency *declaration* rather than code that
 * runs. Matched on the basename, so a nested manifest (`src/client/package.json`)
 * counts as one without this list having to know the repo's layout.
 */
const MANIFEST_FILENAMES = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
]);

/** One commit in the range being considered for release. */
export interface UnreleasedCommit {
  sha: string;
  author: string;
  subject: string;
  /** Paths the commit touched, repo-relative. Empty for an unsquashed merge. */
  files: string[];
}

/**
 * Does this commit touch nothing but dependency declarations? An empty file
 * list is deliberately *not* manifest-only: `git log --name-only` prints no
 * paths for a merge commit, and "we could not see what it changed" must read
 * as the unsafe answer rather than the safe one.
 */
export function isManifestOnly(files: readonly string[]): boolean {
  return files.length > 0 && files.every((file) => MANIFEST_FILENAMES.has(basename(file)));
}

/**
 * The commits in an unreleased range that the automated path must not publish:
 * dependabot-authored, and touching something other than a manifest. Anything
 * a human authored is theirs to release, and a manifest-only bump rides along.
 */
export function blockingCommits(commits: readonly UnreleasedCommit[]): UnreleasedCommit[] {
  return commits.filter(
    (commit) => commit.author === DEPENDABOT_AUTHOR && !isManifestOnly(commit.files),
  );
}

/** Manifest-only bumps riding along in this release, for the run log. */
export function exemptCommits(commits: readonly UnreleasedCommit[]): UnreleasedCommit[] {
  return commits.filter(
    (commit) => commit.author === DEPENDABOT_AUTHOR && isManifestOnly(commit.files),
  );
}

const RECORD = "\u0000";
const FIELD = "\u001f";

/** The `--format` this parser expects, kept beside the parser that reads it. */
export const GIT_LOG_FORMAT = "%x00%H%x1f%an%x1f%s";

/** Parse `git log --format=GIT_LOG_FORMAT --name-only` output into commits. */
export function parseGitLog(output: string): UnreleasedCommit[] {
  return output
    .split(RECORD)
    .filter((record) => record.trim() !== "")
    .map((record) => {
      const [header = "", ...rest] = record.split("\n");
      const [sha = "", author = "", subject = ""] = header.split(FIELD);
      return { sha, author, subject, files: rest.filter((line) => line.trim() !== "") };
    });
}

/** One line naming a commit and what it touched, for the run log. */
export function describeCommit(commit: UnreleasedCommit): string {
  const where = commit.files.length > 0 ? commit.files.join(", ") : "an unreadable file list";
  return `${commit.sha.slice(0, 8)} ${commit.subject} — touches ${where}`;
}

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}

/** The newest `v*` tag, i.e. the last version that actually published. */
export function latestReleaseTag(): string {
  return git("tag", "--list", "v*", "--sort=-v:refname").split("\n")[0]?.trim() ?? "";
}

/** Commits between the last release and HEAD, or all of history if none. */
export function unreleasedCommits(range: string): UnreleasedCommit[] {
  return parseGitLog(git("log", range, `--format=${GIT_LOG_FORMAT}`, "--name-only"));
}

function main() {
  const tag = latestReleaseTag();
  const range = process.argv[2] ?? `${tag ? `${tag}..` : ""}HEAD`;
  const commits = unreleasedCommits(range);
  const blocking = blockingCommits(commits);

  for (const commit of exemptCommits(commits)) {
    console.log(`dependency bump riding along (manifest only): ${describeCommit(commit)}`);
  }

  if (blocking.length === 0) {
    console.log(`release guard: ${commits.length} unreleased commit(s) in ${range}, none blocking`);
    return;
  }

  for (const commit of blocking) {
    console.log(`::error::unreviewed dependency change: ${describeCommit(commit)}`);
  }
  console.log(
    "::error::Review the change above, then run the Publish to NPM workflow from the Actions tab. Dispatching is the approval, and it moves the release tag past the commit.",
  );
  process.exit(1);
}

if (import.meta.main) {
  main();
}
