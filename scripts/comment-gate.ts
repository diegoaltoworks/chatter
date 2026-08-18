/**
 * Pure logic behind the comment-hygiene gate (`bun test scripts/comment-gate`).
 *
 * A comment is only as good as its claims staying true, and only as safe as
 * what it leaks about how the code came to be. This turns five ways a
 * comment goes bad into mechanical checks:
 *
 *  - An em-dash anywhere in tracked source/docs. Banned by the project style
 *    rule (see CONTRIBUTING.md), but the existing count predates the rule
 *    being enforced mechanically - `emDashCount` backs a ratchet in
 *    comment-gate.test.ts that the baseline may only decrease, not a
 *    zero-tolerance check, so this file does not itself claim a number.
 *  - A comment stating this package's current released version. The release
 *    workflow owns `package.json#version` (see docs/packaging.md); a
 *    comment that hardcodes it goes stale the moment the next merge
 *    auto-publishes.
 *  - A `path/to/file.ts:<line>`-style anchor pointing at a file or line that
 *    no longer exists - the same failure mode `docs-toc.test.ts` guards
 *    against for doc links, applied to inline comment anchors.
 *  - A tracker ticket id (this repo's Jira project key followed by a
 *    number) in a comment. Tracker state belongs in the PR description; a
 *    ticket reference baked into a comment rots the moment the ticket
 *    closes or gets renumbered.
 *  - A source-code comment naming where lifted code came from. That is
 *    development history that belongs in the PR description that lifted
 *    the code, not a comment that outlives it.
 *
 * comment-gate.test.ts feeds these every `.ts` file (including `*.test.ts`
 * - a stray ticket id or stale anchor in a test file is just as much a
 * problem as in source) under `src/`, `bin/`, and `scripts/`, plus every
 * `.md` file under `docs/` and the root `CONTRIBUTING.md`/`README.md`.
 * `CHANGELOG.md`, `SECURITY.md`, and `CODE_OF_CONDUCT.md` are out of scope:
 * a changelog's whole job is recording old version numbers, which is
 * exactly what the release-version-pin rule exists to catch elsewhere.
 */

export interface CommentGateViolation {
  file: string;
  line: number;
  reason: string;
}

/**
 * The comment text on this line, or `""` if there is none - so a rule can
 * scan it without also matching code or a string literal. Markdown has no
 * code, so the whole line counts as prose. A `.ts` line that is entirely a
 * comment (block-comment body or a bare `//` line) returns the whole line;
 * a code line with a trailing `// ...` returns just that trailing part,
 * found by walking the line quote-aware so a `//` inside a string (a URL,
 * for instance) is never mistaken for a comment marker.
 */
function commentPortion(text: string, isMarkdown: boolean): string {
  if (isMarkdown) return text;
  if (/^\s*(\*|\/\/|\/\*)/.test(text)) return text;

  let quote: string | null = null;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quote) {
      if (char === "\\") {
        index++;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
    } else if (char === "/" && text[index + 1] === "/") {
      return text.slice(index);
    }
  }
  return "";
}

/** Total em-dash occurrences in `contents`, comments or not - the style rule also covers user-facing strings. */
export function emDashCount(contents: string): number {
  return (contents.match(/—/g) ?? []).length;
}

/**
 * A comment stating `currentVersion` verbatim (this package's own released
 * version, read from `package.json` by the caller so this stays a pure
 * string match rather than a filesystem read).
 */
export function releaseVersionPinViolations(
  relativePath: string,
  contents: string,
  currentVersion: string,
): CommentGateViolation[] {
  const isMarkdown = relativePath.endsWith(".md");
  // A leading `v` is optional and not part of the boundary check, so a
  // "v"-prefixed version tag is caught the same as a bare one.
  const pattern = new RegExp(`(?<![\\w.])v?${currentVersion.replace(/\./g, "\\.")}\\b`);

  const violations: CommentGateViolation[] = [];
  contents.split("\n").forEach((text, index) => {
    const comment = commentPortion(text, isMarkdown);
    if (pattern.test(comment)) {
      violations.push({
        file: relativePath,
        line: index + 1,
        reason: `comment states the current package version (${currentVersion}) verbatim - the release workflow owns this number and it goes stale on the next publish; point at package.json or phrase it qualitatively instead`,
      });
    }
  });
  return violations;
}

/** A `path:line` token, path must contain a directory separator so a version string or ratio (`3:2`) is never mistaken for an anchor. */
const FILE_LINE_ANCHOR = /\b((?:[\w.-]+\/)+[\w.-]+\.(?:ts|tsx|js|mjs|md|json))(?::)(\d+)\b/g;

export interface FileLookup {
  exists(path: string): boolean;
  lineCount(path: string): number;
}

/** `a/b/../c` -> `a/c`; a `..` past the root just drops (there's nowhere higher to go). */
function normalizeSegments(path: string): string {
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "." || segment === "") continue;
    if (segment === "..") out.pop();
    else out.push(segment);
  }
  return out.join("/");
}

/**
 * Resolves `anchoredPath` two ways and returns whichever one `lookup`
 * confirms exists: as written, root-relative (this repo's own convention -
 * see docs/ARCHITECTURE.md's `src/foo/bar.ts` style references), and
 * relative to the directory containing `relativePath` (in case a comment
 * anchors a sibling file `./`-style). Prefers the root-relative reading on
 * a tie, since that's the convention actually in use.
 */
function resolveAnchor(anchoredPath: string, relativePath: string, lookup: FileLookup): string {
  if (lookup.exists(anchoredPath)) return anchoredPath;
  const dir = relativePath.includes("/")
    ? relativePath.slice(0, relativePath.lastIndexOf("/"))
    : "";
  const viaDir = normalizeSegments(dir ? `${dir}/${anchoredPath}` : anchoredPath);
  return lookup.exists(viaDir) ? viaDir : anchoredPath;
}

/**
 * A `path/to/file.ts:<line>`-style anchor in a comment, checked against `lookup`:
 * the file must exist and have at least that many lines. `lookup` is
 * injected so this stays a pure string check in tests; comment-gate.test.ts
 * wires it to the real filesystem for the repo-wide scan.
 */
export function fileLineAnchorViolations(
  relativePath: string,
  contents: string,
  lookup: FileLookup,
): CommentGateViolation[] {
  const isMarkdown = relativePath.endsWith(".md");

  const violations: CommentGateViolation[] = [];
  contents.split("\n").forEach((text, index) => {
    const comment = commentPortion(text, isMarkdown);
    for (const match of comment.matchAll(FILE_LINE_ANCHOR)) {
      const [, anchoredPath, lineText] = match;
      const anchoredLine = Number(lineText);
      const resolvedPath = resolveAnchor(anchoredPath, relativePath, lookup);
      if (!lookup.exists(resolvedPath)) {
        violations.push({
          file: relativePath,
          line: index + 1,
          reason: `comment anchors "${anchoredPath}:${anchoredLine}" but ${anchoredPath} does not exist`,
        });
        continue;
      }
      const lineCount = lookup.lineCount(resolvedPath);
      if (anchoredLine > lineCount) {
        violations.push({
          file: relativePath,
          line: index + 1,
          reason: `comment anchors "${anchoredPath}:${anchoredLine}" but ${anchoredPath} only has ${lineCount} lines`,
        });
      }
    }
  });
  return violations;
}

/**
 * This repo's Jira project key. Scoped to
 * `CHAT` specifically, not a generic `[A-Z]+-\d+` shape - a generic pattern
 * false-positives on ordinary tech acronyms that are also letters-hyphen-digits
 * (`SHA-256`, `UTF-8`, `AES-256`, `GPT-4`).
 */
const TICKET_ID = /\bCHAT-\d{1,6}\b/g;

/** Tokens that look like a ticket id but are pre-approved (a spec/RFC reference, not tracker state). Empty by default; extend as a real case shows up. */
export const TICKET_ID_ALLOWLIST: ReadonlySet<string> = new Set();

/** A tracker ticket id in a comment, unless it's in `allowlist`. */
export function ticketIdViolations(
  relativePath: string,
  contents: string,
  allowlist: ReadonlySet<string> = TICKET_ID_ALLOWLIST,
): CommentGateViolation[] {
  const isMarkdown = relativePath.endsWith(".md");

  const violations: CommentGateViolation[] = [];
  contents.split("\n").forEach((text, index) => {
    const comment = commentPortion(text, isMarkdown);
    for (const match of comment.matchAll(TICKET_ID)) {
      if (allowlist.has(match[0])) continue;
      violations.push({
        file: relativePath,
        line: index + 1,
        reason: `comment references ticket id "${match[0]}" - tracker state belongs in the PR/commit that closes it, not in a comment that outlives the ticket`,
      });
    }
  });
  return violations;
}

const REFERENCE_IMPLEMENTATION = /\breference implementation\b/i;

/**
 * `file:line` locations pre-approved to spell out the naming rule this check
 * enforces - stating the rule is not a leak of what it forbids. Empty by
 * default; extend if prose ever needs to describe the rule.
 */
export const REFERENCE_IMPLEMENTATION_ALLOWLIST: ReadonlySet<string> = new Set();

/**
 * A comment naming where lifted code came from (this docstring avoids
 * spelling out the flagged term so this file doesn't flag itself). That
 * provenance is development history, not something a reader needs to
 * understand the current code; it belongs in the PR description that
 * lifted the code, not a comment that outlives it.
 */
export function referenceImplementationViolations(
  relativePath: string,
  contents: string,
  allowlist: ReadonlySet<string> = REFERENCE_IMPLEMENTATION_ALLOWLIST,
): CommentGateViolation[] {
  const isMarkdown = relativePath.endsWith(".md");

  const violations: CommentGateViolation[] = [];
  contents.split("\n").forEach((text, index) => {
    const comment = commentPortion(text, isMarkdown);
    if (REFERENCE_IMPLEMENTATION.test(comment) && !allowlist.has(`${relativePath}:${index + 1}`)) {
      violations.push({
        file: relativePath,
        line: index + 1,
        reason:
          'comment names "the reference implementation" - provenance belongs in the PR description that lifted the code, not a comment that outlives it',
      });
    }
  });
  return violations;
}
