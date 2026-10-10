/**
 * Section-aware chunker tests. Beyond the per-case expectations, every
 * document is checked for the lossless invariant: the chunk texts hold each
 * non-blank input line exactly once, in order, with contiguous positions.
 */

import { describe, expect, test } from "bun:test";
import { chunkSections } from "./chunking";

const nonBlank = (s: string) =>
  s
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((l) => l.trim() !== "");

function expectLossless(doc: string, max: number) {
  const chunks = chunkSections(doc, max);
  expect(chunks.flatMap((c) => nonBlank(c.text))).toEqual(nonBlank(doc));
  expect(chunks.map((c) => c.position)).toEqual(chunks.map((_, i) => i));
  for (const c of chunks) expect(c.text.trim()).not.toBe("");
  return chunks;
}

describe("chunkSections trail", () => {
  test("tracks H1/H2/H3, a skipped level and a return to a shallower level", () => {
    const doc = ["# A", "a", "## B", "b", "#### D", "d", "## C", "c", "# E", "e"].join("\n");
    const chunks = expectLossless(doc, 900);
    expect(chunks.map((c) => c.section)).toEqual([
      ["A"],
      ["A", "B"],
      ["A", "B", "D"],
      ["A", "C"],
      ["E"],
    ]);
    expect(chunks[1].text).toBe("## B\n\nb");
  });

  test("text before the first heading has an empty trail", () => {
    const chunks = expectLossless("intro line\n\n# A\nbody", 900);
    expect(chunks[0]).toEqual({ text: "intro line", section: [], position: 0 });
    expect(chunks[1].section).toEqual(["A"]);
  });

  test("does not merge consecutive small sections", () => {
    expect(expectLossless("# A\nx\n# B\ny\n# C\nz", 900)).toHaveLength(3);
  });

  test("a heading with no body is still a chunk", () => {
    const chunks = expectLossless("# A\n## B\nbody", 900);
    expect(chunks.map((c) => c.text)).toEqual(["# A", "## B\n\nbody"]);
  });

  test("strips closing hashes from the trail", () => {
    expect(chunkSections("## Title ##\nx")[0].section).toEqual(["Title"]);
  });
});

describe("chunkSections splitting", () => {
  test("no headings: splits on paragraphs under the cap", () => {
    const doc = ["aaaa aaaa", "bbbb bbbb", "cccc cccc"].join("\n\n");
    const chunks = expectLossless(doc, 20);
    expect(chunks.map((c) => c.text)).toEqual(["aaaa aaaa\n\nbbbb bbbb", "cccc cccc"]);
    expect(chunks.every((c) => c.section.length === 0)).toBe(true);
  });

  test("oversized section splits on paragraphs and keeps the trail on every piece", () => {
    const doc = ["# A", "## B", "p1 p1 p1", "", "p2 p2 p2", "", "p3 p3 p3"].join("\n");
    const chunks = expectLossless(doc, 25);
    const b = chunks.filter((c) => c.section.join("/") === "A/B");
    expect(b.length).toBeGreaterThan(1);
    expect(b[0].text.startsWith("## B")).toBe(true);
  });

  test("a section that fits stays one chunk", () => {
    expect(expectLossless("# A\np1\n\np2", 900)).toHaveLength(1);
  });
});

describe("chunkSections atomic blocks", () => {
  const filler = "x".repeat(30);
  const cases: [string, string[]][] = [
    ["fenced code block", ["```ts", "const a = 1;", "", "const b = 2;", "```"]],
    ["tilde fence", ["~~~", "one", "", "two", "~~~"]],
    ["bullet list", ["- one", "- two", "  - nested", "- three"]],
    ["loose list", ["1. one", "", "2. two", "", "   more of two", "", "3. three"]],
    ["table", ["| a | b |", "| - | - |", "| 1 | 2 |", "| 3 | 4 |"]],
  ];

  test.each(cases)("%s is kept whole across the cap", (_name, block) => {
    const doc = ["# A", filler, "", block.join("\n"), "", filler].join("\n");
    const chunks = expectLossless(doc, 40);
    const holder = chunks.filter((c) => c.text.includes(block.join("\n")));
    expect(holder).toHaveLength(1);
  });

  test("a hash line inside a code fence is not a heading", () => {
    const doc = ["# A", "```sh", "# not a heading", "```", "after"].join("\n");
    const chunks = expectLossless(doc, 900);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].section).toEqual(["A"]);
  });

  test("an unclosed fence runs to the end of the document", () => {
    const chunks = expectLossless("# A\n```\n# x\nmore", 900);
    expect(chunks).toHaveLength(1);
  });
});

describe("chunkSections input handling", () => {
  test("normalises CRLF", () => {
    const chunks = chunkSections("# A\r\nx\r\n\r\n# B\r\ny\r\n");
    expect(chunks.map((c) => c.text)).toEqual(["# A\n\nx", "# B\n\ny"]);
  });

  test.each(["", "   ", "\n\n\t\n", "\r\n"])("yields nothing for blank input %p", (doc) => {
    expect(chunkSections(doc)).toEqual([]);
  });
});
