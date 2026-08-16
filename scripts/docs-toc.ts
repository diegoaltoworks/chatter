/**
 * Pure logic behind the docs table-of-contents check (`bun test scripts/docs-toc`).
 *
 * `README.md`'s "Documentation" section and `docs/index.md`'s "Quick
 * Navigation" are two hand-maintained lists of the same `docs/*.md` files.
 * Nothing enforced they stay complete, so each drifted independently — a new
 * guide got added to `docs/` without a matching link in one or both lists,
 * and nothing caught it. This turns "every doc file is linked from a given
 * piece of markdown" into a pure, testable check so a new doc that forgets
 * its ToC entry fails the gate instead of just going unlisted.
 *
 * scripts/docs-toc.test.ts feeds it fixtures and this repo's actual files.
 */

/**
 * `docs/*.md` files a ToC is expected to link, in the shape `readdirSync`
 * returns them: every markdown file in `docs/` except `index.md` itself
 * (which is the page the docs-side ToC lives on, not an entry in it).
 */
export function expectedDocFiles(docsDirEntries: readonly string[]): string[] {
  return docsDirEntries.filter((name) => name.endsWith(".md") && name !== "index.md").sort();
}

/**
 * Which of `files` has no markdown link target `${linkPrefix}${file}` inside
 * `markdown`. A substring check rather than a link-syntax parse: the
 * property that matters is "the path appears as a link target somewhere",
 * and a regex parse of markdown link syntax would add complexity a
 * substring search already covers correctly for this repo's docs.
 */
export function missingDocLinks(
  files: readonly string[],
  markdown: string,
  linkPrefix: string,
): string[] {
  return files.filter((file) => !markdown.includes(`${linkPrefix}${file}`));
}

/**
 * The body of the `## <heading>` section (exact text, any `#` depth) up to
 * the next heading at the same or a shallower depth. Scoping to the section
 * matters: checking a whole ToC-carrying file for "is this path linked
 * anywhere" lets an unrelated mention elsewhere in the file (a Features
 * bullet, a cross-reference in prose) mask a genuinely missing ToC entry.
 * `#`-prefixed lines inside fenced code blocks (shell comments, e.g.) are not
 * headings and are ignored for both finding the section and ending it.
 * Throws if `heading` isn't found, so a renamed heading fails loudly rather
 * than silently checking an empty section.
 */
export function sectionBody(markdown: string, heading: string): string {
  const lines = markdown.split("\n");
  let inFence = false;
  let startDepth = 0;
  let started = false;
  const body: string[] = [];

  for (const line of lines) {
    if (/^```/.test(line.trim())) inFence = !inFence;

    if (!started) {
      if (!inFence) {
        const match = line.match(/^(#+)\s+(.*)$/);
        if (match && match[2].trim() === heading) {
          started = true;
          startDepth = match[1].length;
        }
      }
      continue;
    }

    if (!inFence) {
      const match = line.match(/^(#+)\s/);
      if (match && match[1].length <= startDepth) break;
    }
    body.push(line);
  }

  if (!started) throw new Error(`heading "${heading}" not found`);
  return body.join("\n");
}
