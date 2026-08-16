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
 */

/** A call site that bypasses the brain hook, with a note on why it counts. */
export interface InvariantViolation {
  file: string;
  line: number;
  reason: string;
}

const CALL = /\b(completeOnce|completeStream)\s*\(/g;

/** Files allowed to hold a call: where the functions are defined, and their one sanctioned caller. */
const ALLOWED_CALLERS = new Set(["core/answer.ts", "core/llm.ts"]);

/** Is this line a comment (block or line)? A call mentioned in prose is not a call site. */
function isComment(text: string): boolean {
  return /^\s*(\*|\/\/|\/\*)/.test(text);
}

/** The code before any trailing `//` comment, so a call mentioned there is not a call site either. */
function codePart(text: string): string {
  return text.split("//")[0];
}

/**
 * `completeOnce`/`completeStream` call sites in one file, outside the files
 * allowed to hold them. A bare import or re-export (no `(`) does not count —
 * `src/index.ts` re-exports both names for callers who intentionally want
 * the raw completion functions instead of the brain hook, and that re-export
 * is not the invariant this guards against.
 */
export function completionCallViolations(
  relativePath: string,
  contents: string,
): InvariantViolation[] {
  if (ALLOWED_CALLERS.has(relativePath)) return [];

  const violations: InvariantViolation[] = [];
  contents.split("\n").forEach((text, index) => {
    if (isComment(text)) return;
    for (const match of codePart(text).matchAll(CALL)) {
      violations.push({
        file: relativePath,
        line: index + 1,
        reason: `${match[1]}(...) called outside core/answer.ts, bypassing the answerFn hook`,
      });
    }
  });
  return violations;
}
