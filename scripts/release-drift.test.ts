import { describe, expect, test } from "bun:test";
import {
  assessDrift,
  DEFAULT_GRACE_MINUTES,
  type DriftInput,
  GIT_LOG_FORMAT,
  parseGitLog,
  versionOf,
} from "./release-drift";

const NOW = new Date("2026-08-17T06:00:00Z");

/** Minutes before NOW, as the ISO string a `%cI` field would carry. */
function agoISO(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString();
}

function input(overrides: Partial<DriftInput> = {}): DriftInput {
  return {
    latestTag: "v1.2.3",
    publishedVersion: "1.2.3",
    unreleased: [],
    now: NOW,
    graceMinutes: DEFAULT_GRACE_MINUTES,
    ...overrides,
  };
}

describe("versionOf", () => {
  test("strips the tag's v prefix", () => {
    expect(versionOf("v1.0.0")).toBe("1.0.0");
  });

  test("leaves an unprefixed version alone", () => {
    expect(versionOf("1.0.0")).toBe("1.0.0");
  });
});

describe("assessDrift", () => {
  test("a clean repo, tag and registry agreeing, is not stalled", () => {
    const verdict = assessDrift(input());

    expect(verdict.stalled).toBe(false);
    expect(verdict.reason).toContain("Nothing unreleased");
  });

  test("a tag npm does not serve is stalled, even with nothing unreleased", () => {
    const verdict = assessDrift(input({ latestTag: "v1.3.0", publishedVersion: "1.2.3" }));

    expect(verdict.stalled).toBe(true);
    expect(verdict.reason).toContain("v1.3.0");
    expect(verdict.reason).toContain("1.2.3");
  });

  test("an unreadable registry never reports drift on its own", () => {
    expect(assessDrift(input({ publishedVersion: "" })).stalled).toBe(false);
  });

  test("a repo that has never released does not trip the tag comparison", () => {
    expect(assessDrift(input({ latestTag: "", publishedVersion: "" })).stalled).toBe(false);
  });

  // The incident this exists for: merges landing on main and never publishing,
  // with nothing in the chain failing because nothing in the chain ran.
  test("human commits older than the grace period are stalled", () => {
    const verdict = assessDrift(
      input({
        unreleased: [
          { sha: "aeb81b1abcdef", author: "Diego", committedAt: agoISO(11 * 60) },
          { sha: "f32f98affffff", author: "Diego", committedAt: agoISO(10 * 60) },
        ],
      }),
    );

    expect(verdict.stalled).toBe(true);
    expect(verdict.reason).toContain("aeb81b1a");
    expect(verdict.reason).toContain("660");
  });

  test("a merge inside the grace period is a release in flight, not drift", () => {
    const verdict = assessDrift(
      input({ unreleased: [{ sha: "abc1234", author: "Diego", committedAt: agoISO(5) }] }),
    );

    expect(verdict.stalled).toBe(false);
    expect(verdict.reason).toContain("grace period");
  });

  test("the age reported is the oldest commit's, not the newest", () => {
    const verdict = assessDrift(
      input({
        unreleased: [
          { sha: "newer12", author: "Diego", committedAt: agoISO(130) },
          { sha: "older34", author: "Diego", committedAt: agoISO(600) },
        ],
      }),
    );

    expect(verdict.reason).toContain("older34");
    expect(verdict.reason).toContain("600");
  });

  // A bump waiting on a human-authored merge is release-guard.ts working as
  // designed, so it must never page anyone, however long it waits.
  test("dependabot commits alone are never drift, however old", () => {
    const verdict = assessDrift(
      input({
        unreleased: [
          { sha: "dep1111", author: "dependabot[bot]", committedAt: agoISO(60 * 24 * 7) },
        ],
      }),
    );

    expect(verdict.stalled).toBe(false);
    expect(verdict.reason).toContain("by design");
  });

  test("a human commit beside a dependabot one still counts", () => {
    const verdict = assessDrift(
      input({
        unreleased: [
          { sha: "dep1111", author: "dependabot[bot]", committedAt: agoISO(60 * 24) },
          { sha: "hum2222", author: "Diego", committedAt: agoISO(300) },
        ],
      }),
    );

    expect(verdict.stalled).toBe(true);
    expect(verdict.reason).toContain("hum2222");
    expect(verdict.reason).toContain("1 human-authored");
  });

  test("an unparseable commit date does not report a bogus age", () => {
    const verdict = assessDrift(
      input({ unreleased: [{ sha: "bad0000", author: "Diego", committedAt: "not a date" }] }),
    );

    expect(verdict.stalled).toBe(false);
    expect(verdict.reason).toContain("0 minute(s) old");
  });

  test("a commit dated in the future reads as zero minutes, not negative", () => {
    const verdict = assessDrift(
      input({ unreleased: [{ sha: "future1", author: "Diego", committedAt: agoISO(-90) }] }),
    );

    expect(verdict.stalled).toBe(false);
  });
});

describe("parseGitLog", () => {
  const RECORD = "\u0000";
  const FIELD = "\u001f";

  test("reads the fields the format emits, in order", () => {
    const output = [
      `${RECORD}aeb81b1${FIELD}Diego${FIELD}2026-08-16T19:02:20+01:00`,
      `${RECORD}def0ca0${FIELD}dependabot[bot]${FIELD}2026-08-16T11:24:55+00:00`,
      "",
    ].join("\n");

    expect(parseGitLog(output)).toEqual([
      { sha: "aeb81b1", author: "Diego", committedAt: "2026-08-16T19:02:20+01:00" },
      { sha: "def0ca0", author: "dependabot[bot]", committedAt: "2026-08-16T11:24:55+00:00" },
    ]);
  });

  test("an empty range parses to no commits", () => {
    expect(parseGitLog("")).toEqual([]);
  });

  test("the format names the same three fields the parser splits out", () => {
    expect(GIT_LOG_FORMAT.split("%x1f")).toHaveLength(3);
  });
});
