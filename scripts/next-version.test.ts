import { describe, expect, test } from "bun:test";
import { applyBump, bumpFromCommits, type CommitInfo, parseCommits } from "./next-version";

function commit(subject: string, body = ""): CommitInfo {
  return { subject, body };
}

describe("bumpFromCommits", () => {
  test("fix, chore, and docs subjects all bump patch", () => {
    expect(bumpFromCommits([commit("fix: resolve bug")], "0.48.0")).toBe("patch");
    expect(bumpFromCommits([commit("chore: maintenance")], "0.48.0")).toBe("patch");
    expect(bumpFromCommits([commit("docs: update readme")], "0.48.0")).toBe("patch");
  });

  test("a feat subject bumps minor", () => {
    expect(bumpFromCommits([commit("feat: add new feature")], "0.48.0")).toBe("minor");
  });

  test("a scoped feat subject still counts", () => {
    expect(bumpFromCommits([commit("feat(routes): add endpoint")], "0.48.0")).toBe("minor");
  });

  test("one feat among several fixes still bumps minor", () => {
    const commits = [commit("fix: a"), commit("chore: b"), commit("feat: c"), commit("docs: d")];
    expect(bumpFromCommits(commits, "0.48.0")).toBe("minor");
  });

  test("an unconventional subject is treated as patch, not thrown on", () => {
    expect(bumpFromCommits([commit("Merge pull request #90")], "0.48.0")).toBe("patch");
  });

  test("no commits is patch", () => {
    expect(bumpFromCommits([], "0.48.0")).toBe("patch");
  });

  test("before 1.0, a `!` breaking marker still only reaches minor", () => {
    expect(bumpFromCommits([commit("feat!: drop the old config shape")], "0.48.0")).toBe("minor");
    expect(bumpFromCommits([commit("feat(api)!: change the response shape")], "0.48.0")).toBe(
      "minor",
    );
  });

  test("before 1.0, a BREAKING CHANGE footer still only reaches minor", () => {
    const commits = [commit("fix: adjust behavior", "BREAKING CHANGE: callers must update")];
    expect(bumpFromCommits(commits, "0.48.0")).toBe("minor");
  });

  test("at or past 1.0, a `!` breaking marker bumps major", () => {
    expect(bumpFromCommits([commit("feat!: drop the old config shape")], "1.2.3")).toBe("major");
    expect(bumpFromCommits([commit("fix(api)!: change the response shape")], "1.2.3")).toBe(
      "major",
    );
  });

  test("at or past 1.0, a BREAKING CHANGE footer bumps major", () => {
    const commits = [commit("fix: adjust behavior", "BREAKING CHANGE: callers must update")];
    expect(bumpFromCommits(commits, "1.2.3")).toBe("major");
  });

  test("at or past 1.0, a BREAKING-CHANGE footer (hyphenated) also counts", () => {
    const commits = [commit("fix: adjust behavior", "BREAKING-CHANGE: callers must update")];
    expect(bumpFromCommits(commits, "1.2.3")).toBe("major");
  });

  test("at or past 1.0, breaking beats a plain feat in the same range", () => {
    const commits = [commit("feat: add thing"), commit("fix!: remove old thing")];
    expect(bumpFromCommits(commits, "1.2.3")).toBe("major");
  });

  test("a footer only counts if it starts a line", () => {
    const commits = [commit("fix: adjust behavior", "See also BREAKING CHANGE: not a footer")];
    expect(bumpFromCommits(commits, "1.2.3")).toBe("patch");
  });

  test("a footer on its own line after the body text still counts", () => {
    const body = "Explains the change.\n\nBREAKING CHANGE: callers must update";
    expect(bumpFromCommits([commit("fix: adjust behavior", body)], "1.2.3")).toBe("major");
  });
});

describe("applyBump", () => {
  test("patch increments the patch component", () => {
    expect(applyBump("0.47.0", "patch")).toBe("0.47.1");
  });

  test("minor increments minor and resets patch", () => {
    expect(applyBump("0.47.3", "minor")).toBe("0.48.0");
  });

  test("major increments major and resets minor and patch", () => {
    expect(applyBump("1.4.3", "major")).toBe("2.0.0");
  });

  test("rejects a malformed version", () => {
    expect(() => applyBump("0.47", "patch")).toThrow();
    expect(() => applyBump("not.a.version", "patch")).toThrow();
  });
});

describe("parseCommits", () => {
  const SEP = "\x1e";
  const FIELD = "\x1f";

  test("parses subject and body for a single commit", () => {
    const raw = `feat: add thing${FIELD}some body text${SEP}\n`;
    expect(parseCommits(raw)).toEqual([{ subject: "feat: add thing", body: "some body text" }]);
  });

  test("parses multiple commits", () => {
    const raw = `feat: a${FIELD}${SEP}\nfix: b${FIELD}body${SEP}\n`;
    expect(parseCommits(raw)).toEqual([
      { subject: "feat: a", body: "" },
      { subject: "fix: b", body: "body" },
    ]);
  });

  test("a commit with no field separator has an empty body", () => {
    const raw = `feat: a${SEP}\n`;
    expect(parseCommits(raw)).toEqual([{ subject: "feat: a", body: "" }]);
  });

  test("empty input parses to no commits", () => {
    expect(parseCommits("")).toEqual([]);
  });
});
