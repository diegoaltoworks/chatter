/**
 * Pure logic behind the docs dead-link check (`bun test scripts/docs-links`).
 *
 * `docs-toc.ts` guards the opposite direction: that every doc file is linked
 * from a ToC. Nothing checked that the links themselves resolve, so a guide
 * renamed or a section retitled left cross-references pointing at nothing,
 * and the gates stayed green. This turns "every relative markdown link
 * resolves to a file that exists, and to a heading that exists when it
 * carries a `#fragment`" into a pure, testable check.
 *
 * Absolute links (`http:`, `https:`, `mailto:`) are out of scope: resolving
 * them means a network call, which would make the gates flaky and offline
 * runs impossible.
 *
 * scripts/docs-links.test.ts feeds it fixtures and this repo's actual files.
 */

export interface DeadLink {
  file: string;
  link: string;
  reason: "missing file" | "missing anchor";
}

/** A markdown file's path and text, as the checker consumes it. */
export interface MarkdownFile {
  /** Path relative to the repository root, POSIX-separated. */
  path: string;
  text: string;
}

const LINK = /\[[^\]]*\]\(([^)\s]+)\)/g;
const HEADING = /^#{1,6}\s+(.+)$/gm;

/**
 * GitHub's heading-to-anchor rule as this repo needs it: lowercase, drop
 * everything that is not a word character, whitespace or hyphen, then
 * collapse whitespace runs to single hyphens. Inline markdown in a heading
 * (backticks, emphasis) falls out of the punctuation strip on its own, which
 * is why there is no separate un-markdown pass.
 */
export function headingSlug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Every anchor a link may target within `text`, as slugs. */
export function anchorsIn(text: string): Set<string> {
  const anchors = new Set<string>();
  for (const match of text.matchAll(HEADING)) anchors.add(headingSlug(match[1]));
  return anchors;
}

/**
 * The relative link targets in `text`, absolute and protocol links dropped.
 * A bare `#fragment` is kept: it targets a heading in the linking file
 * itself, which is just as capable of going stale as a cross-file one.
 */
export function relativeLinks(text: string): string[] {
  const links: string[] = [];
  for (const match of text.matchAll(LINK)) {
    const link = match[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(link) || link.startsWith("//")) continue;
    links.push(link);
  }
  return links;
}

/**
 * Resolves `link` from `fromPath`, both POSIX-relative to the repo root, to
 * the path it targets. Done here rather than with `node:path` so the checker
 * stays pure and testable without a filesystem, and so results are always
 * POSIX-separated regardless of host platform.
 */
export function resolveLink(fromPath: string, link: string): string {
  const parts = fromPath.split("/").slice(0, -1).concat(link.split("/"));
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

/**
 * Every relative link across `files` that resolves to nothing. A link's
 * target file must be one of `files` or listed in `otherPaths` (assets, source
 * files, anything not itself markdown); anchors are only checked when the
 * target is markdown, since that is the only case where the headings are known.
 *
 * Directories resolve too: docs routinely link a whole example folder, and
 * only file paths are passed in, so a target that is a parent of some known
 * path counts as existing.
 */
export function deadLinks(
  files: readonly MarkdownFile[],
  otherPaths: readonly string[] = [],
): DeadLink[] {
  const markdown = new Map(files.map((file) => [file.path, file]));
  const existing = new Set<string>([...markdown.keys(), ...otherPaths]);
  for (const path of [...existing]) {
    const segments = path.split("/");
    for (let depth = 1; depth < segments.length; depth++) {
      existing.add(segments.slice(0, depth).join("/"));
    }
  }
  const dead: DeadLink[] = [];

  for (const file of files) {
    for (const link of relativeLinks(file.text)) {
      const [path, fragment] = splitFragment(link);
      const target = path === "" ? file.path : resolveLink(file.path, path);

      if (!existing.has(target)) {
        dead.push({ file: file.path, link, reason: "missing file" });
        continue;
      }

      const targetFile = markdown.get(target);
      if (fragment && targetFile && !anchorsIn(targetFile.text).has(fragment)) {
        dead.push({ file: file.path, link, reason: "missing anchor" });
      }
    }
  }
  return dead;
}

function splitFragment(link: string): [string, string] {
  const hash = link.indexOf("#");
  return hash === -1 ? [link, ""] : [link.slice(0, hash), link.slice(hash + 1)];
}
