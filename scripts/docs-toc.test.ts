import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expectedDocFiles, missingDocLinks, sectionBody } from "./docs-toc";

describe("expectedDocFiles", () => {
  test("lists markdown files, sorted, excluding index.md", () => {
    expect(expectedDocFiles(["b.md", "index.md", "a.md"])).toEqual(["a.md", "b.md"]);
  });

  test("ignores non-markdown entries", () => {
    expect(expectedDocFiles(["a.md", "assets", "notes.txt"])).toEqual(["a.md"]);
  });

  test("empty directory yields no expected files", () => {
    expect(expectedDocFiles([])).toEqual([]);
  });

  test("a recursive listing's subdirectory entries are not mistaken for files", () => {
    expect(expectedDocFiles(["a.md", "decisions", "decisions/0001-x.md"])).toEqual([
      "a.md",
      "decisions/0001-x.md",
    ]);
  });
});

describe("missingDocLinks", () => {
  test("a file linked with the given prefix is not missing", () => {
    const markdown = "See [Guide](./docs/guide.md) for more.";
    expect(missingDocLinks(["guide.md"], markdown, "./docs/")).toEqual([]);
  });

  test("a file never linked is missing", () => {
    expect(missingDocLinks(["guide.md"], "nothing here", "./docs/")).toEqual(["guide.md"]);
  });

  test("a link under the wrong prefix does not count", () => {
    const markdown = "[Guide](./guide.md)";
    expect(missingDocLinks(["guide.md"], markdown, "./docs/")).toEqual(["guide.md"]);
  });

  test("reports every missing file, not just the first", () => {
    const markdown = "[A](./docs/a.md)";
    expect(missingDocLinks(["a.md", "b.md", "c.md"], markdown, "./docs/")).toEqual([
      "b.md",
      "c.md",
    ]);
  });
});

describe("sectionBody", () => {
  test("returns the lines between a heading and the next of the same depth", () => {
    const markdown = "# Title\n\n## A\nbody a\n\n## B\nbody b\n";
    expect(sectionBody(markdown, "A").trim()).toBe("body a");
  });

  test("stops at a shallower heading too, not just an equal one", () => {
    const markdown = "## A\nbody a\n\n# Shallower\nnot in A\n";
    expect(sectionBody(markdown, "A").trim()).toBe("body a");
  });

  test("includes deeper subheadings as part of the section body", () => {
    const markdown = "## A\n### Sub\nnested\n\n## B\n";
    expect(sectionBody(markdown, "A")).toContain("### Sub");
    expect(sectionBody(markdown, "A")).toContain("nested");
  });

  test("runs to the end of the file when there is no following heading", () => {
    const markdown = "## A\nbody a\nmore\n";
    expect(sectionBody(markdown, "A").trim()).toBe("body a\nmore");
  });

  test("ignores a `#`-prefixed line inside a fenced code block", () => {
    const markdown = "## A\n```bash\n# not a heading\n```\nreal body\n\n## B\nother\n";
    const body = sectionBody(markdown, "A");
    expect(body).toContain("real body");
    expect(body).not.toContain("## B");
  });

  test("throws when the heading is not present", () => {
    expect(() => sectionBody("## A\nbody\n", "Missing")).toThrow();
  });
});

// The point of the helpers above: this repo's README and docs/index.md ToCs
// actually list every guide in docs/. A new docs/*.md file that forgets its
// link in either place fails here instead of just going unlisted.
describe("this repo's documentation ToCs", () => {
  const root = join(import.meta.dir, "..");
  const docsDir = join(root, "docs");
  // Recursive: docs/decisions/ and docs/patterns/ hold real guides too, and a
  // file that only readdirSync's the top level would never see them go
  // unlinked.
  const docFiles = expectedDocFiles(readdirSync(docsDir, { recursive: true }) as string[]);
  const readme = readFileSync(join(root, "README.md"), "utf8");
  const docsIndex = readFileSync(join(docsDir, "index.md"), "utf8");

  test("there are docs to list", () => {
    expect(docFiles.length).toBeGreaterThan(0);
  });

  test("README.md's Documentation section links every docs/*.md file", () => {
    const documentation = sectionBody(readme, "Documentation");
    expect(missingDocLinks(docFiles, documentation, "./docs/")).toEqual([]);
  });

  test("docs/index.md's Quick Navigation section links every other docs/*.md file", () => {
    const quickNav = sectionBody(docsIndex, "Quick Navigation");
    expect(missingDocLinks(docFiles, quickNav, "./")).toEqual([]);
  });
});
