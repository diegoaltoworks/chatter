import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { anchorsIn, deadLinks, headingSlug, relativeLinks, resolveLink } from "./docs-links";

describe("headingSlug", () => {
  test("lowercases and hyphenates", () => {
    expect(headingSlug("Quick Navigation")).toBe("quick-navigation");
  });

  test("drops punctuation and inline markdown", () => {
    expect(headingSlug("`config.retriever`, explained!")).toBe("configretriever-explained");
  });

  test("collapses whitespace runs to one hyphen", () => {
    expect(headingSlug("A   B")).toBe("a-b");
  });

  test("keeps existing hyphens and trims stray ones", () => {
    expect(headingSlug("- Pre-1.0 -")).toBe("pre-10");
  });
});

describe("anchorsIn", () => {
  test("collects headings at every depth", () => {
    expect(anchorsIn("# One\n### Two Three\n")).toEqual(new Set(["one", "two-three"]));
  });

  test("a hash without a following space is not a heading", () => {
    expect(anchorsIn("#nospace\n")).toEqual(new Set());
  });
});

describe("relativeLinks", () => {
  test("keeps relative paths", () => {
    expect(relativeLinks("[a](./a.md) and [b](../b/c.md)")).toEqual(["./a.md", "../b/c.md"]);
  });

  test("drops http, https and mailto links", () => {
    const text = "[a](https://x.dev) [b](http://x.dev) [c](mailto:x@y.dev) [d](//x.dev)";
    expect(relativeLinks(text)).toEqual([]);
  });

  test("keeps a bare fragment", () => {
    expect(relativeLinks("[a](#a-section)")).toEqual(["#a-section"]);
  });
});

describe("resolveLink", () => {
  test("resolves a sibling", () => {
    expect(resolveLink("docs/a.md", "./b.md")).toBe("docs/b.md");
  });

  test("resolves a parent traversal", () => {
    expect(resolveLink("docs/patterns/a.md", "../b.md")).toBe("docs/b.md");
  });

  test("resolves out of docs to the repo root", () => {
    expect(resolveLink("docs/a.md", "../README.md")).toBe("README.md");
  });
});

describe("deadLinks", () => {
  const target = { path: "docs/b.md", text: "## Live Section\n" };

  test("a link to an existing file and heading is fine", () => {
    const from = { path: "docs/a.md", text: "[b](./b.md#live-section)" };
    expect(deadLinks([from, target])).toEqual([]);
  });

  test("a link to a missing file is reported", () => {
    const from = { path: "docs/a.md", text: "[gone](./gone.md)" };
    expect(deadLinks([from, target])).toEqual([
      { file: "docs/a.md", link: "./gone.md", reason: "missing file" },
    ]);
  });

  test("a link to a missing heading is reported", () => {
    const from = { path: "docs/a.md", text: "[b](./b.md#dead-section)" };
    expect(deadLinks([from, target])).toEqual([
      { file: "docs/a.md", link: "./b.md#dead-section", reason: "missing anchor" },
    ]);
  });

  test("a bare fragment is checked against the linking file's own headings", () => {
    const from = { path: "docs/a.md", text: "## Here\n[ok](#here) [bad](#there)" };
    expect(deadLinks([from])).toEqual([
      { file: "docs/a.md", link: "#there", reason: "missing anchor" },
    ]);
  });

  test("a non-markdown target counts as existing when listed", () => {
    const from = { path: "docs/a.md", text: "[src](../src/index.ts)" };
    expect(deadLinks([from], ["src/index.ts"])).toEqual([]);
    expect(deadLinks([from])).toHaveLength(1);
  });

  test("a link to a directory holding a known path resolves", () => {
    const from = { path: "docs/a.md", text: "[examples](../examples/full-bot/)" };
    expect(deadLinks([from], ["examples/full-bot/index.ts"])).toEqual([]);
  });

  test("a link to a directory nothing lives under is still reported", () => {
    const from = { path: "docs/a.md", text: "[examples](../examples/gone/)" };
    expect(deadLinks([from], ["examples/full-bot/index.ts"])).toHaveLength(1);
  });

  test("an anchor on a non-markdown target is not checked", () => {
    const from = { path: "docs/a.md", text: "[src](../src/index.ts#L10)" };
    expect(deadLinks([from], ["src/index.ts"])).toEqual([]);
  });
});

// The point of the helpers above: every relative link in this repo's own
// markdown resolves. A renamed guide or a retitled section that leaves a
// cross-reference dangling fails here instead of shipping.
describe("this repo's documentation links", () => {
  const root = join(import.meta.dir, "..");
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  const markdown = tracked
    .filter((path) => path.endsWith(".md"))
    .map((path) => ({ path, text: readFileSync(join(root, path), "utf8") }));

  test("there is markdown to check", () => {
    expect(markdown.length).toBeGreaterThan(0);
  });

  test("no relative link points at a missing file or heading", () => {
    expect(deadLinks(markdown, tracked)).toEqual([]);
  });
});
