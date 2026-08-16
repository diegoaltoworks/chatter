import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  auditWorkflow,
  dockerBunVersions,
  floatingBunVersions,
  missingDependabotGate,
  missingReleaseVerification,
  parseActionUses,
  publishesToNpm,
  toolchainDrift,
  unfrozenInstalls,
  unpinnedActions,
  workflowBunVersions,
} from "./supply-chain";

const PINNED = "abcdef0123456789abcdef0123456789abcdef01";

/** A publish workflow carrying both halves of the gate, for negative tests. */
const GATED_PUBLISH = [
  "if: github.event.workflow_run.head_commit.author.name != 'dependabot[bot]'",
  "- run: |",
  "    git log \"$RANGE\" --format='%an' | grep -qxF 'dependabot[bot]' && exit 1",
  "- run: npm publish --provenance",
].join("\n");

describe("parseActionUses", () => {
  test("reads the action, its ref, and the version comment", () => {
    const [use] = parseActionUses("ci.yml", `      - uses: actions/checkout@${PINNED} # v7.0.1`);

    expect(use).toEqual({
      file: "ci.yml",
      line: 1,
      action: "actions/checkout",
      ref: PINNED,
      comment: "v7.0.1",
    });
  });

  test("finds a `uses:` written as a step key rather than a list item", () => {
    const [use] = parseActionUses("ci.yml", "        uses: oven-sh/setup-bun@v1");

    expect(use?.action).toBe("oven-sh/setup-bun");
    expect(use?.ref).toBe("v1");
  });

  test("splits on the last @, so a subpath reference survives", () => {
    const [use] = parseActionUses(
      "ci.yml",
      `      - uses: owner/repo/sub/action@${PINNED} # v1.0.0`,
    );

    expect(use?.action).toBe("owner/repo/sub/action");
    expect(use?.ref).toBe(PINNED);
  });

  test("unwraps a quoted reference, which is otherwise read as a broken pin", () => {
    const [use] = parseActionUses("ci.yml", `      - uses: "actions/checkout@${PINNED}" # v7.0.1`);

    expect(use?.action).toBe("actions/checkout");
    expect(use?.ref).toBe(PINNED);
  });

  test("reports the line each reference sits on", () => {
    const uses = parseActionUses(
      "ci.yml",
      ["steps:", "  - run: echo hi", `  - uses: a/b@${PINNED} # v1.0.0`].join("\n"),
    );

    expect(uses.map((u) => u.line)).toEqual([3]);
  });

  test("skips a commented-out reference", () => {
    expect(parseActionUses("ci.yml", "      # - uses: actions/checkout@v7")).toEqual([]);
  });
});

describe("unpinnedActions", () => {
  test("flags a tag reference, naming the ref it found", () => {
    const [violation] = unpinnedActions(
      parseActionUses("ci.yml", "      - uses: actions/checkout@v7"),
    );

    expect(violation?.reason).toContain("actions/checkout");
    expect(violation?.reason).toContain('"v7"');
  });

  test("flags a branch reference just as hard as a tag", () => {
    expect(
      unpinnedActions(parseActionUses("ci.yml", "      - uses: some/action@main")),
    ).toHaveLength(1);
  });

  test("flags a SHA pin with no version comment, which dependabot cannot update", () => {
    const [violation] = unpinnedActions(
      parseActionUses("ci.yml", `      - uses: actions/checkout@${PINNED}`),
    );

    expect(violation?.reason).toContain("no version comment");
  });

  test("accepts a commented SHA pin", () => {
    expect(
      unpinnedActions(
        parseActionUses("ci.yml", `      - uses: actions/checkout@${PINNED} # v7.0.1`),
      ),
    ).toEqual([]);
  });

  test("ignores local and docker actions, which are not pinned this way", () => {
    const uses = parseActionUses(
      "ci.yml",
      ["      - uses: ./.github/actions/setup", "      - uses: docker://alpine:3"].join("\n"),
    );

    expect(unpinnedActions(uses)).toEqual([]);
  });
});

describe("unfrozenInstalls", () => {
  test("flags a bare `bun install`", () => {
    const [violation] = unfrozenInstalls("ci.yml", "      - run: bun install");

    expect(violation?.reason).toContain("--frozen-lockfile");
  });

  test("flags the aliases that reach the registry the same way", () => {
    const contents = ["  - run: bun i", "  - run: bun add zod", "  - run: bun update"].join("\n");

    expect(unfrozenInstalls("ci.yml", contents).map((v) => v.line)).toEqual([1, 2, 3]);
  });

  test("accepts an install that pins to the lockfile", () => {
    expect(unfrozenInstalls("ci.yml", "      - run: bun install --frozen-lockfile")).toEqual([]);
  });

  test("does not mistake `bun installer` for an install", () => {
    expect(unfrozenInstalls("ci.yml", "      - run: echo bun installer")).toEqual([]);
  });

  test("does not flag an install mentioned in a comment", () => {
    expect(unfrozenInstalls("ci.yml", "      # bun install runs in the reusable workflow")).toEqual(
      [],
    );
  });
});

describe("floatingBunVersions", () => {
  test("flags `latest`", () => {
    const [violation] = floatingBunVersions("ci.yml", "          bun-version: latest");

    expect(violation?.reason).toContain("latest");
  });

  test("flags a range that still lets the patch float", () => {
    expect(floatingBunVersions("ci.yml", "          bun-version: 1.3")).toHaveLength(1);
  });

  test("flags bun-version-file, which would move the pin out of view", () => {
    const [violation] = floatingBunVersions("ci.yml", "          bun-version-file: .bun-version");

    expect(violation?.reason).toContain("bun-version-file");
  });

  test("accepts an exact version, quoted or bare", () => {
    expect(floatingBunVersions("ci.yml", "          bun-version: 1.3.14")).toEqual([]);
    expect(floatingBunVersions("ci.yml", '          bun-version: "1.3.14"')).toEqual([]);
  });
});

describe("toolchainDrift", () => {
  test("reads the version out of a workflow and a Dockerfile alike", () => {
    expect(workflowBunVersions("          bun-version: 1.3.14")).toEqual(["1.3.14"]);
    expect(dockerBunVersions("FROM oven/bun:1.3.14-slim AS runtime")).toEqual(["1.3.14"]);
  });

  test("accepts one version named many times", () => {
    expect(toolchainDrift(["1.3.14", "1.3.14", "1.3.14"])).toEqual([]);
  });

  test("flags the image drifting away from the version CI tested, naming both", () => {
    const [violation] = toolchainDrift(["1.3.14", "1.4.0"]);

    expect(violation?.reason).toContain("1.3.14");
    expect(violation?.reason).toContain("1.4.0");
  });
});

describe("publishesToNpm", () => {
  test("recognises the workflow that pushes the tarball", () => {
    expect(publishesToNpm("      - run: npm publish --provenance --access public")).toBe(true);
  });

  test("does not count a mention in a comment", () => {
    expect(publishesToNpm("      # npm publish happens in npm-publish.yml")).toBe(false);
  });
});

describe("missingDependabotGate", () => {
  test("flags a publish condition with no dependabot guard at all", () => {
    const violations = missingDependabotGate(
      "npm-publish.yml",
      "if: github.event.workflow_run.conclusion == 'success'",
    );

    expect(violations).toHaveLength(2);
  });

  test("flags a tip guard with no scan of the unreleased range", () => {
    const contents = "if: github.event.workflow_run.head_commit.author.name != 'dependabot[bot]'";
    const [violation] = missingDependabotGate("npm-publish.yml", contents);

    expect(violation?.reason).toContain("unreleased range");
  });

  test("flags a range scan with no tip guard", () => {
    const contents = "- run: git log \"$RANGE\" --format='%an' | grep -qxF 'dependabot[bot]'";
    const [violation] = missingDependabotGate("npm-publish.yml", contents);

    expect(violation?.reason).toContain("head commit");
  });

  test("accepts a workflow carrying both guards", () => {
    expect(missingDependabotGate("npm-publish.yml", GATED_PUBLISH)).toEqual([]);
  });

  test("accepts the range scan delegated to the release guard script", () => {
    const contents = [
      "if: github.event.workflow_run.head_commit.author.name != 'dependabot[bot]'",
      "- run: bun scripts/release-guard.ts",
      "- run: npm publish --provenance",
    ].join("\n");

    expect(missingDependabotGate("npm-publish.yml", contents)).toEqual([]);
  });

  test("does not accept a guard that survives only as a comment", () => {
    const commented = GATED_PUBLISH.split("\n")
      .map((line) => `# ${line}`)
      .join("\n");

    expect(missingDependabotGate("npm-publish.yml", `${commented}\nif: true`)).toHaveLength(2);
  });
});

describe("missingReleaseVerification", () => {
  test("flags a publish path that verifies neither the tarball nor Node", () => {
    const violations = missingReleaseVerification("npm-publish.yml", GATED_PUBLISH);

    expect(violations).toHaveLength(2);
  });

  test("flags the half that is missing", () => {
    const [violation] = missingReleaseVerification(
      "npm-publish.yml",
      `${GATED_PUBLISH}\n- run: bun run test:pack`,
    );

    expect(violation?.reason).toContain("under Node");
  });

  test("accepts a publish path that runs both", () => {
    const contents = [GATED_PUBLISH, "- run: bun run test:pack", "- run: bun run test:node"].join(
      "\n",
    );

    expect(missingReleaseVerification("npm-publish.yml", contents)).toEqual([]);
  });

  test("does not accept a check that survives only as a comment", () => {
    const contents = `${GATED_PUBLISH}\n# - run: bun run test:pack && bun run test:node`;

    expect(missingReleaseVerification("npm-publish.yml", contents)).toHaveLength(2);
  });

  test("does not accept a bare mention of the script name that never runs it", () => {
    const contents = `${GATED_PUBLISH}\n- run: echo "remember to keep test:pack and test:node green"`;

    expect(missingReleaseVerification("npm-publish.yml", contents)).toHaveLength(2);
  });

  test("does not accept a longer script the target is only a prefix of", () => {
    const contents = `${GATED_PUBLISH}\n- run: bun run test:pack:extra\n- run: bun run test:node`;

    const violations = missingReleaseVerification("npm-publish.yml", contents);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toContain("tarball");
  });

  test("accepts the script run via npm instead of bun", () => {
    const contents = [GATED_PUBLISH, "- run: npm run test:pack", "- run: npm run test:node"].join(
      "\n",
    );

    expect(missingReleaseVerification("npm-publish.yml", contents)).toEqual([]);
  });
});

describe("auditWorkflow", () => {
  test("collects every kind of violation, ordered by line", () => {
    const contents = [
      "      - uses: actions/checkout@v7",
      "        with:",
      "          bun-version: latest",
      "      - run: bun install",
    ].join("\n");

    expect(auditWorkflow("ci.yml", contents).map((v) => v.line)).toEqual([1, 3, 4]);
  });

  test("demands the dependabot gate and the artifact checks of any publisher", () => {
    const contents = "      - run: npm publish --provenance --access public";

    expect(auditWorkflow("release-anything.yml", contents)).toHaveLength(4);
  });

  test("does not demand it of a workflow that does not publish", () => {
    expect(auditWorkflow("ci.yml", "      - run: bun install --frozen-lockfile")).toEqual([]);
  });
});

// The point of the helpers above: the configuration this repo actually ships
// has to satisfy them. A new workflow, or a copy-pasted step in an old one,
// fails here rather than on the day a tag moves under us.
describe("this repo's CI configuration", () => {
  const root = join(import.meta.dir, "..");
  const workflowDir = join(root, ".github", "workflows");
  const workflows = readdirSync(workflowDir).filter((name) => /\.ya?ml$/.test(name));
  const read = (name: string) => readFileSync(join(workflowDir, name), "utf8");

  test("there are workflows to audit", () => {
    expect(workflows.length).toBeGreaterThan(0);
  });

  for (const file of workflows) {
    test(`${file} pins its actions, its bun, and its lockfile`, () => {
      expect(auditWorkflow(file, read(file))).toEqual([]);
    });
  }

  test("exactly one workflow publishes, and it is gated", () => {
    const publishers = workflows.filter((file) => publishesToNpm(read(file)));

    expect(publishers).toEqual(["npm-publish.yml"]);
    expect(missingDependabotGate("npm-publish.yml", read("npm-publish.yml"))).toEqual([]);
    expect(missingReleaseVerification("npm-publish.yml", read("npm-publish.yml"))).toEqual([]);
  });

  test("the Dockerfile's installs use --frozen-lockfile", () => {
    expect(unfrozenInstalls("Dockerfile", readFileSync(join(root, "Dockerfile"), "utf8"))).toEqual(
      [],
    );
  });

  test("the Dockerfile builds on the same bun the gates ran under", () => {
    const versions = [
      ...workflows.flatMap((file) => workflowBunVersions(read(file))),
      ...dockerBunVersions(readFileSync(join(root, "Dockerfile"), "utf8")),
    ];

    expect(versions.length).toBeGreaterThan(1);
    expect(toolchainDrift(versions)).toEqual([]);
  });
});
