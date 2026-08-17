/**
 * The watchdog on the release chain - `bun scripts/release-drift.ts`, run on a
 * schedule by .github/workflows/release-watchdog.yml.
 *
 * Every other guard in the release path runs *inside* the chain: they assume a
 * merge produced a CI run, and that CI run's completion woke the publish
 * workflow. On 2026-08-16 that assumption broke. GitHub stopped creating
 * workflow runs for this repository for roughly seventeen hours (no `push`
 * runs, no `pull_request` runs, no check suite at all on the merge commits),
 * so eleven merges landed on `main` with nothing to gate them and nothing to
 * publish them. Nothing failed, because nothing ran. The registry stayed on
 * the previous day's version while `main` carried a knowledge-base data-loss
 * fix that production never received.
 *
 * A guard that only runs when the chain runs cannot see that. This one is
 * driven by the clock instead, so it fires precisely when the event-driven
 * half is the thing that is broken, and it asks the question from the outside:
 * does the newest release tag match what npm serves, and has anything been
 * sitting unreleased on `main` for longer than a release takes?
 *
 * Dependabot-authored commits are exempt: by design they wait on a
 * human-authored merge or a dispatch (see scripts/release-guard.ts), so a
 * lone bump sitting unreleased is the system working, not drift.
 *
 * The pure half is exported and unit-tested in scripts/release-drift.test.ts.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { DEPENDABOT_AUTHOR } from "./release-guard";

/** How long a human-authored merge may sit on `main` before this complains. */
export const DEFAULT_GRACE_MINUTES = 120;

/** One commit on `main` that no release tag covers yet. */
export interface UnreleasedCommit {
  sha: string;
  author: string;
  /** Committer date, ISO 8601. Committer, not author: a rebased commit's
   * author date can predate the merge by days and would read as instant drift. */
  committedAt: string;
}

export interface DriftInput {
  /** Newest `v*` tag, or "" when nothing has ever been released. */
  latestTag: string;
  /** What `npm view <pkg> dist-tags.latest` returns, or "" if unreadable. */
  publishedVersion: string;
  unreleased: readonly UnreleasedCommit[];
  now: Date;
  graceMinutes: number;
}

export interface DriftVerdict {
  stalled: boolean;
  /** One sentence, used as both the log line and the issue body. */
  reason: string;
}

/** `v1.2.3` -> `1.2.3`; anything else is returned unchanged. */
export function versionOf(tag: string): string {
  return tag.startsWith("v") ? tag.slice(1) : tag;
}

/** Whole minutes between two instants, floored, never negative. */
function minutesSince(then: string, now: Date): number {
  const elapsed = now.getTime() - new Date(then).getTime();
  return Number.isNaN(elapsed) ? 0 : Math.max(0, Math.floor(elapsed / 60_000));
}

/**
 * The two ways the chain strands work, checked in the order they strand it.
 *
 * A tag that npm does not serve means the publish step itself died after the
 * release commit landed, which is the more urgent of the two: `main`'s version
 * already claims to be released. Unreleased commits mean the chain never got
 * that far. Reporting the tag mismatch first keeps the issue body pointed at
 * the earlier failure rather than at its symptom.
 */
export function assessDrift({
  latestTag,
  publishedVersion,
  unreleased,
  now,
  graceMinutes,
}: DriftInput): DriftVerdict {
  if (latestTag !== "" && publishedVersion !== "" && versionOf(latestTag) !== publishedVersion) {
    return {
      stalled: true,
      reason: `${latestTag} is the newest release tag but npm serves ${publishedVersion} as latest, so a tagged release never reached the registry.`,
    };
  }

  const human = unreleased.filter((commit) => commit.author !== DEPENDABOT_AUTHOR);
  if (human.length === 0) {
    const waiting = unreleased.length;
    return {
      stalled: false,
      reason:
        waiting === 0
          ? `Nothing unreleased on main; npm and ${latestTag || "the repository"} agree.`
          : `${waiting} dependency bump(s) unreleased, which is by design: they ship with the next human-authored merge or a dispatch.`,
    };
  }

  const oldest = human.reduce((a, b) => (a.committedAt <= b.committedAt ? a : b));
  const age = minutesSince(oldest.committedAt, now);
  if (age <= graceMinutes) {
    return {
      stalled: false,
      reason: `${human.length} commit(s) unreleased, oldest ${age} minute(s) old, within the ${graceMinutes} minute grace period.`,
    };
  }

  return {
    stalled: true,
    reason: `${human.length} human-authored commit(s) have been unreleased on main for up to ${age} minutes (oldest: ${oldest.sha.slice(0, 8)}), past the ${graceMinutes} minute grace period. Check that the merge produced a push-event CI run and that it woke "Publish to NPM".`,
  };
}

const RECORD = "\u0000";
const FIELD = "\u001f";

/** The `--format` this parser expects, kept beside the parser that reads it. */
export const GIT_LOG_FORMAT = "%x00%H%x1f%an%x1f%cI";

/** Parse `git log --format=GIT_LOG_FORMAT` output into commits. */
export function parseGitLog(output: string): UnreleasedCommit[] {
  return output
    .split(RECORD)
    .filter((record) => record.trim() !== "")
    .map((record) => {
      const [sha = "", author = "", committedAt = ""] = record.trim().split(FIELD);
      return { sha, author, committedAt };
    });
}

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}

/** npm's `latest` dist-tag, or "" when the registry cannot be read. */
export function publishedLatest(pkg: string): string {
  try {
    return execFileSync("npm", ["view", pkg, "dist-tags.latest"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

/** Emit `key=value` for a workflow step's outputs, when running as one. */
function setOutput(key: string, value: string): void {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  appendFileSync(file, `${key}<<CHATTER_EOF\n${value}\nCHATTER_EOF\n`);
}

/**
 * Always exits 0. The workflow decides what a stall is worth (an issue, then a
 * failed run) off the `stalled` output, so a non-zero exit here would only
 * skip the steps that report the problem.
 */
function main() {
  const pkg = process.argv[2] ?? "";
  const graceMinutes = Number(process.argv[3] ?? DEFAULT_GRACE_MINUTES);
  const latestTag = git("tag", "--list", "v*", "--sort=-v:refname").split("\n")[0]?.trim() ?? "";
  const range = latestTag ? `${latestTag}..HEAD` : "HEAD";

  const verdict = assessDrift({
    latestTag,
    publishedVersion: pkg ? publishedLatest(pkg) : "",
    unreleased: parseGitLog(git("log", range, `--format=${GIT_LOG_FORMAT}`)),
    now: new Date(),
    graceMinutes,
  });

  console.log(verdict.stalled ? `::error::${verdict.reason}` : verdict.reason);
  setOutput("stalled", String(verdict.stalled));
  setOutput("reason", verdict.reason);
}

if (import.meta.main) {
  main();
}
