/**
 * Derives the next release version from conventional commits since the last
 * release tag, so a chore/docs/fix merge ships a patch, a feat merge ships a
 * minor, and a breaking change ships a major.
 * The major tier is gated on the version being bumped from, which the workflow
 * takes from the latest release tag rather than from package.json. While that
 * version is still 0.x a breaking change caps at minor: semver leaves 0.x
 * compatibility undefined, so minor is already the strongest signal available
 * there. This repo is version-agnostic on purpose and keeps both branches.
 * Breaking changes are read from a `!` before the `:` (`feat!:`, `fix(api)!:`)
 * or a `BREAKING CHANGE:` / `BREAKING-CHANGE:` footer in the commit body.
 */

export type Bump = "major" | "minor" | "patch";

export interface CommitInfo {
  subject: string;
  body: string;
}

const CONVENTIONAL_TYPE = /^([a-z]+)(\([^)]+\))?(!)?:/;
const BREAKING_FOOTER = /^BREAKING[ -]CHANGE:/m;

function isBreaking(commit: CommitInfo): boolean {
  return CONVENTIONAL_TYPE.exec(commit.subject)?.[3] === "!" || BREAKING_FOOTER.test(commit.body);
}

/** Highest bump implied by a set of commits, given the version they'd apply to. */
export function bumpFromCommits(commits: CommitInfo[], currentVersion: string): Bump {
  const major = Number(currentVersion.split(".")[0]);
  const pastOne = Number.isInteger(major) && major >= 1;

  if (commits.some(isBreaking)) return pastOne ? "major" : "minor";
  const isFeat = commits.some((commit) => CONVENTIONAL_TYPE.exec(commit.subject)?.[1] === "feat");
  return isFeat ? "minor" : "patch";
}

/** Applies a bump to a `major.minor.patch` version string. */
export function applyBump(version: string, bump: Bump): string {
  const parts = version.split(".").map(Number);
  const [major, minor, patch] = parts;
  if (parts.length !== 3 || [major, minor, patch].some((n) => !Number.isInteger(n))) {
    throw new Error(`not a major.minor.patch version: ${version}`);
  }
  if (bump === "major") return `${major + 1}.0.0`;
  return bump === "minor" ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
}

const COMMIT_SEP = "\x1e";
const FIELD_SEP = "\x1f";

/** Reverses `git log --format='%s${FIELD_SEP}%b${COMMIT_SEP}'`. */
export function parseCommits(raw: string): CommitInfo[] {
  return raw
    .split(COMMIT_SEP)
    .map((chunk) => chunk.replace(/^\n+/, "").trimEnd())
    .filter(Boolean)
    .map((chunk) => {
      const sep = chunk.indexOf(FIELD_SEP);
      return sep === -1
        ? { subject: chunk, body: "" }
        : { subject: chunk.slice(0, sep), body: chunk.slice(sep + 1) };
    });
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const [mode, ...rest] = process.argv.slice(2);
  if (mode === "bump") {
    const [currentVersion] = rest;
    if (!currentVersion) {
      throw new Error("usage: next-version.ts bump <current-version> < commits on stdin");
    }
    const commits = parseCommits(await readStdin());
    process.stdout.write(bumpFromCommits(commits, currentVersion));
    return;
  }
  if (mode === "apply") {
    const [version, bump] = rest;
    if (!version || (bump !== "major" && bump !== "minor" && bump !== "patch")) {
      throw new Error("usage: next-version.ts apply <major.minor.patch> <major|minor|patch>");
    }
    process.stdout.write(applyBump(version, bump));
    return;
  }
  throw new Error(
    "usage: next-version.ts bump <current-version> | apply <version> <major|minor|patch>",
  );
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
