/**
 * Derives the next release version from conventional-commit subjects, so a
 * chore/docs/fix merge ships a patch and only a feat merge ships a minor.
 * A `!` breaking-change marker (`feat!:`, `fix!:`) still only reaches minor
 * here — a distinct major-bump tier is reserved for when that matters, post-1.0.
 * `BREAKING CHANGE:` footers (commit body, not subject) are not read.
 */

export type Bump = "minor" | "patch";

const CONVENTIONAL_TYPE = /^([a-z]+)(\([^)]+\))?!?:/;

/** Highest bump implied by a set of commit subjects: any `feat` (or `feat!`) -> minor, else patch. */
export function bumpFromCommitSubjects(subjects: string[]): Bump {
  const isFeat = subjects.some((subject) => CONVENTIONAL_TYPE.exec(subject)?.[1] === "feat");
  return isFeat ? "minor" : "patch";
}

/** Applies a bump to a `major.minor.patch` version string. */
export function applyBump(version: string, bump: Bump): string {
  const parts = version.split(".").map(Number);
  const [major, minor, patch] = parts;
  if (parts.length !== 3 || [major, minor, patch].some((n) => !Number.isInteger(n))) {
    throw new Error(`not a major.minor.patch version: ${version}`);
  }
  return bump === "minor" ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const [mode, ...rest] = process.argv.slice(2);
  if (mode === "bump") {
    const subjects = (await readStdin()).split("\n").filter(Boolean);
    process.stdout.write(bumpFromCommitSubjects(subjects));
    return;
  }
  if (mode === "apply") {
    const [version, bump] = rest;
    if (!version || (bump !== "minor" && bump !== "patch")) {
      throw new Error("usage: next-version.ts apply <major.minor.patch> <minor|patch>");
    }
    process.stdout.write(applyBump(version, bump));
    return;
  }
  throw new Error(
    "usage: next-version.ts bump <commit subjects on stdin> | apply <version> <bump>",
  );
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
