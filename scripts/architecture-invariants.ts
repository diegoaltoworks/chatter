/**
 * Pure logic behind the brain-hook call-site audit
 * (`bun test scripts/architecture-invariants`).
 *
 * Every chat surface answers through `answerOnce`/`answerStream` in
 * `src/core/answer.ts`, which honours a configured `answerFn` before falling
 * back to `completeOnce`/`completeStream` in `src/core/llm.ts` (see
 * docs/ARCHITECTURE.md, invariant 1). A surface that calls
 * `completeOnce`/`completeStream` directly bypasses that hook silently —
 * nothing about the call fails, it just never reaches an `answerFn` a
 * consumer configured. This turns "only core/answer.ts calls the raw
 * completion functions" into a lexical check so a new call site fails the
 * gate instead of quietly drifting the invariant.
 *
 * scripts/architecture-invariants.test.ts feeds it every `.ts` file under
 * `src/` and `bin/` (the package's other shipped runtime entry points),
 * excluding build artefacts and any installed dependency tree.
 *
 * Two evasions a plain name-and-line-comment regex would miss are handled
 * explicitly: a call reached through a renamed import (`{ completeOnce as
 * run }` then `run(...)`), and a `//` that only occurs inside a string or
 * template literal earlier on the line (that is not a comment marker, and
 * must not be read as one - see `codePart` below).
 */

/** A call site that bypasses the brain hook, with a note on why it counts. */
export interface InvariantViolation {
  file: string;
  line: number;
  reason: string;
}

// The lookbehind excludes a preceding `.`/word char/`$` so a member call on
// some unrelated object (`server.run(1)`) sharing an alias's name is not
// mistaken for a call to the aliased import.
const CALL = /(?<![.\w$])(completeOnce|completeStream)\s*\(/g;

/** `{ completeOnce as run }` style import aliases, local name -> real name. */
const IMPORT_ALIAS = /\b(completeOnce|completeStream)\s+as\s+(\w+)/g;

/** Only a real `import { ... } from "..."` declaration can introduce an alias - not a comment or string that happens to say the same words. */
const IMPORT_BLOCK = /\bimport\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["'][^"']+["']/g;

/** Files allowed to hold a call: where the functions are defined, and their one sanctioned caller. */
const ALLOWED_CALLERS = new Set(["core/answer.ts", "core/llm.ts"]);

/** Is this line a comment (block or line)? A call mentioned in prose is not a call site. */
function isComment(text: string): boolean {
  return /^\s*(\*|\/\/|\/\*)/.test(text);
}

/**
 * The code before any trailing `//` line comment. Scanned character by
 * character, tracking whether a quote is open, so a `//` inside a string or
 * template literal (a URL, a message that mentions "//") is not mistaken for
 * a comment marker - a naive `text.split("//")[0]` truncates there and drops
 * any real call site later on the same line.
 */
function codePart(text: string): string {
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
      return text.slice(0, index);
    }
  }
  // A `"`/`'` still open at end of line is not a real string - those can't
  // span a line unescaped. It is almost always a quote character inside a
  // regex character class (e.g. `/['"]/`) that this line-based scan has no
  // way to tell apart from a real string open, so trust it least: fall back
  // to a plain search rather than let it swallow real code into a fake
  // unterminated string. A `` ` `` is left alone - a template literal can
  // legitimately still be open.
  if (quote && quote !== "`") {
    const commentAt = text.indexOf("//");
    return commentAt === -1 ? text : text.slice(0, commentAt);
  }
  return text;
}

/**
 * Local names an import aliased `completeOnce`/`completeStream` to, mapped
 * back to the real name. Scoped to the `{ ... }` of an actual import
 * declaration (commented-out lines stripped first) - matching against the
 * whole file would also register an alias out of a comment or string that
 * merely mentions the same rename, with nothing importing anything.
 */
function importAliases(contents: string): Map<string, string> {
  const withoutCommentLines = contents
    .split("\n")
    .map((line) => (isComment(line) ? "" : line))
    .join("\n");

  const aliases = new Map<string, string>();
  for (const block of withoutCommentLines.matchAll(IMPORT_BLOCK)) {
    for (const match of block[1].matchAll(IMPORT_ALIAS)) {
      aliases.set(match[2], match[1]);
    }
  }
  return aliases;
}

/** The call pattern to scan with: the real names, plus any local alias found in this file's imports. */
function callPattern(aliases: Map<string, string>): RegExp {
  if (aliases.size === 0) return CALL;
  const names = ["completeOnce", "completeStream", ...aliases.keys()];
  return new RegExp(`(?<![.\\w$])(${names.join("|")})\\s*\\(`, "g");
}

/**
 * `completeOnce`/`completeStream` call sites in one file, outside the files
 * allowed to hold them - including calls made under a renamed import. A bare
 * import or re-export (no `(`) does not count - `src/index.ts` re-exports
 * both names for callers who intentionally want the raw completion functions
 * instead of the brain hook, and that re-export is not the invariant this
 * guards against.
 */
export function completionCallViolations(
  relativePath: string,
  contents: string,
): InvariantViolation[] {
  if (ALLOWED_CALLERS.has(relativePath)) return [];

  const aliases = importAliases(contents);
  const pattern = callPattern(aliases);

  const violations: InvariantViolation[] = [];
  contents.split("\n").forEach((text, index) => {
    if (isComment(text)) return;
    for (const match of codePart(text).matchAll(pattern)) {
      const name = aliases.get(match[1]) ?? match[1];
      const via = aliases.has(match[1]) ? ` (imported as \`${match[1]}\`)` : "";
      violations.push({
        file: relativePath,
        line: index + 1,
        reason: `${name}(...) called outside core/answer.ts${via}, bypassing the answerFn hook`,
      });
    }
  });
  return violations;
}
