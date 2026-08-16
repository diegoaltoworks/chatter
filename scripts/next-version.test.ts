import { describe, expect, test } from "bun:test";
import { applyBump, bumpFromCommitSubjects } from "./next-version";

describe("bumpFromCommitSubjects", () => {
  test("fix, chore, and docs subjects all bump patch", () => {
    expect(bumpFromCommitSubjects(["fix: resolve bug"])).toBe("patch");
    expect(bumpFromCommitSubjects(["chore: maintenance"])).toBe("patch");
    expect(bumpFromCommitSubjects(["docs: update readme"])).toBe("patch");
  });

  test("a feat subject bumps minor", () => {
    expect(bumpFromCommitSubjects(["feat: add new feature"])).toBe("minor");
  });

  test("a scoped feat subject still counts", () => {
    expect(bumpFromCommitSubjects(["feat(routes): add endpoint"])).toBe("minor");
  });

  test("one feat among several fixes still bumps minor", () => {
    expect(bumpFromCommitSubjects(["fix: a", "chore: b", "feat: c", "docs: d"])).toBe("minor");
  });

  test("a breaking-change marker still only reaches minor, not a separate major tier", () => {
    expect(bumpFromCommitSubjects(["feat!: drop the old config shape"])).toBe("minor");
    expect(bumpFromCommitSubjects(["feat(api)!: change the response shape"])).toBe("minor");
  });

  test("an unconventional subject is treated as patch, not thrown on", () => {
    expect(bumpFromCommitSubjects(["Merge pull request #90"])).toBe("patch");
  });

  test("no commits is patch", () => {
    expect(bumpFromCommitSubjects([])).toBe("patch");
  });
});

describe("applyBump", () => {
  test("patch increments the patch component", () => {
    expect(applyBump("0.47.0", "patch")).toBe("0.47.1");
  });

  test("minor increments minor and resets patch", () => {
    expect(applyBump("0.47.3", "minor")).toBe("0.48.0");
  });

  test("rejects a malformed version", () => {
    expect(() => applyBump("0.47", "patch")).toThrow();
    expect(() => applyBump("not.a.version", "patch")).toThrow();
  });
});
