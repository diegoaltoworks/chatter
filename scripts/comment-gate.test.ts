import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  emDashCount,
  type FileLookup,
  fileLineAnchorViolations,
  referenceImplementationViolations,
  releaseVersionPinViolations,
  ticketIdViolations,
} from "./comment-gate";

describe("emDashCount", () => {
  test("counts every occurrence, comment or not", () => {
    expect(emDashCount("a — b — c")).toBe(2);
  });

  test("zero when there are none", () => {
    expect(emDashCount("a, b, c")).toBe(0);
  });
});

describe("releaseVersionPinViolations", () => {
  test("a comment stating the current version verbatim is a violation", () => {
    const violations = releaseVersionPinViolations(
      "src/foo.ts",
      "// as of version 1.2.3 this changed",
      "1.2.3",
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.line).toBe(1);
    expect(violations[0]?.reason).toContain("1.2.3");
  });

  test("the same digits in code (not a comment) are not a violation", () => {
    expect(releaseVersionPinViolations("src/foo.ts", 'const v = "1.2.3";', "1.2.3")).toEqual([]);
  });

  test("a different version number is not a violation", () => {
    expect(releaseVersionPinViolations("src/foo.ts", "// pinned to 1.2.4", "1.2.3")).toEqual([]);
  });

  test("markdown prose is scanned in full, no comment marker required", () => {
    expect(
      releaseVersionPinViolations("docs/foo.md", "Current release: 1.2.3.", "1.2.3"),
    ).toHaveLength(1);
  });
});

describe("fileLineAnchorViolations", () => {
  const lookup: FileLookup = {
    exists: (path) => path === "src/real.ts",
    lineCount: (path) => (path === "src/real.ts" ? 10 : 0),
  };

  test("an anchor to a real file within range is not a violation", () => {
    expect(
      fileLineAnchorViolations("src/foo.ts", "// see src/real.ts:5 for context", lookup),
    ).toEqual([]);
  });

  test("an anchor to a file that doesn't exist is a violation", () => {
    const violations = fileLineAnchorViolations(
      "src/foo.ts",
      "// see src/missing.ts:5 for context",
      lookup,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toContain("src/missing.ts");
  });

  test("an anchor past the end of a real file is a violation", () => {
    const violations = fileLineAnchorViolations(
      "src/foo.ts",
      "// see src/real.ts:99 for context",
      lookup,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toContain("only has 10 lines");
  });

  test("a ratio or version-like token is not mistaken for an anchor", () => {
    expect(fileLineAnchorViolations("src/foo.ts", "// aspect ratio 16:9", lookup)).toEqual([]);
  });

  test("code (not a comment) is ignored", () => {
    expect(fileLineAnchorViolations("src/foo.ts", 'const s = "src/missing.ts:5";', lookup)).toEqual(
      [],
    );
  });
});

describe("ticketIdViolations", () => {
  test("a Jira ticket id in a comment is a violation", () => {
    const violations = ticketIdViolations("src/foo.ts", "// closes CHAT-101");
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toContain("CHAT-101");
  });

  test("an allowlisted token is not a violation", () => {
    expect(ticketIdViolations("src/foo.ts", "// see CHAT-101", new Set(["CHAT-101"]))).toEqual([]);
  });

  test("an unrelated hyphenated acronym is not a violation", () => {
    expect(ticketIdViolations("src/foo.ts", "// hashed with SHA-256")).toEqual([]);
  });

  test("code (not a comment) is ignored", () => {
    expect(ticketIdViolations("src/foo.ts", 'const id = "CHAT-101";')).toEqual([]);
  });

  test("markdown prose is scanned without a comment marker", () => {
    expect(ticketIdViolations("docs/foo.md", "Fixed by CHAT-101.")).toHaveLength(1);
  });
});

describe("referenceImplementationViolations", () => {
  test("a comment naming the reference implementation is a violation", () => {
    const violations = referenceImplementationViolations(
      "src/foo.ts",
      "// lifted from the reference implementation",
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.line).toBe(1);
  });

  test("matching is case-insensitive", () => {
    expect(
      referenceImplementationViolations("src/foo.ts", "// The Reference Implementation did this"),
    ).toHaveLength(1);
  });

  test("an allowlisted file:line is not a violation", () => {
    expect(
      referenceImplementationViolations(
        "docs/foo.md",
        "Never name the reference implementation.",
        new Set(["docs/foo.md:1"]),
      ),
    ).toEqual([]);
  });

  test("code (not a comment) is ignored", () => {
    expect(
      referenceImplementationViolations("src/foo.ts", 'const s = "reference implementation";'),
    ).toEqual([]);
  });

  test("unrelated text is not a violation", () => {
    expect(referenceImplementationViolations("src/foo.ts", "// see the docs for details")).toEqual(
      [],
    );
  });
});

/** Build artefacts and dependency trees this repo's own code never wrote. */
function isGenerated(path: string): boolean {
  return path.includes("node_modules/") || path.includes("/dist/") || path.startsWith("dist/");
}

/** Every `.ts` file under `dir`, relative to `root`, skipping generated trees. */
function tsFilesUnder(root: string, dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[])
    .filter((name) => name.endsWith(".ts") && !isGenerated(name))
    .map((name) => join(dir, name).slice(root.length + 1));
}

const root = join(import.meta.dir, "..");
const srcDir = join(root, "src");
const binDir = join(root, "bin");
const scriptsDir = join(root, "scripts");
const docsDir = join(root, "docs");

const trackedTsFiles = [
  ...tsFilesUnder(root, srcDir),
  ...tsFilesUnder(root, binDir),
  ...tsFilesUnder(root, scriptsDir),
];

const trackedMdFiles = [
  ...(readdirSync(docsDir, { recursive: true }) as string[])
    .filter((name) => name.endsWith(".md"))
    .map((name) => join("docs", name)),
  "CONTRIBUTING.md",
  "README.md",
];

const trackedFiles = [...trackedTsFiles, ...trackedMdFiles];

/** Line count a reader would actually count - a trailing newline is not one more line. */
function realLineCount(text: string): number {
  const lines = text.split("\n");
  return lines.at(-1) === "" ? lines.length - 1 : lines.length;
}

const realLookup: FileLookup = {
  exists: (path) => existsSync(join(root, path)),
  lineCount: (path) => realLineCount(readFileSync(join(root, path), "utf8")),
};

const currentVersion: string = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

/**
 * The em-dash ratchet: how many em-dashes existed across tracked source and
 * docs the day this gate went live. New code must not add any (see
 * CONTRIBUTING.md's "No em-dashes"); this baseline only accounts for what
 * predates the mechanical check and may only shrink as files get touched
 * and cleaned up - lower it whenever a change removes some, never raise it.
 */
const EM_DASH_BASELINE = 490;

describe("this repo's tracked source and docs", () => {
  test("there are files to check", () => {
    expect(trackedFiles.length).toBeGreaterThan(0);
  });

  test("no comment states the current released package version", () => {
    const violations = trackedFiles.flatMap((file) =>
      releaseVersionPinViolations(file, readFileSync(join(root, file), "utf8"), currentVersion),
    );
    expect(violations).toEqual([]);
  });

  test("every file:line comment anchor points at a real file and line", () => {
    const violations = trackedFiles.flatMap((file) =>
      fileLineAnchorViolations(file, readFileSync(join(root, file), "utf8"), realLookup),
    );
    expect(violations).toEqual([]);
  });

  test("no comment references a tracker ticket id", () => {
    const violations = trackedFiles.flatMap((file) =>
      ticketIdViolations(file, readFileSync(join(root, file), "utf8")),
    );
    expect(violations).toEqual([]);
  });

  test("no comment names the reference implementation", () => {
    const violations = trackedFiles.flatMap((file) =>
      referenceImplementationViolations(file, readFileSync(join(root, file), "utf8")),
    );
    expect(violations).toEqual([]);
  });

  test("em-dash count does not exceed the ratchet baseline", () => {
    const total = trackedFiles.reduce(
      (sum, file) => sum + emDashCount(readFileSync(join(root, file), "utf8")),
      0,
    );
    expect(total).toBeLessThanOrEqual(EM_DASH_BASELINE);
  });
});
