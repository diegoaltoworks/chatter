import { describe, expect, test } from "bun:test";
import {
  bundleSizeViolations,
  collectExportEntries,
  hygieneViolations,
  loadPlan,
  missingTargets,
  specifierFor,
} from "./pack-exports";

describe("collectExportEntries", () => {
  test("maps each subpath to the specifier a consumer writes", () => {
    const entries = collectExportEntries("@scope/pkg", {
      ".": { types: "./dist/index.d.ts", import: "./dist/index.mjs", require: "./dist/index.js" },
      "./whatsapp": { types: "./d.d.ts", import: "./d.mjs", require: "./d.js" },
    });

    expect(entries.map((e) => e.specifier)).toEqual(["@scope/pkg", "@scope/pkg/whatsapp"]);
  });

  test("treats a string export as both import and require", () => {
    const [entry] = collectExportEntries("@scope/pkg", { "./package.json": "./package.json" });

    expect(entry?.targets).toEqual({ import: "./package.json", require: "./package.json" });
  });

  test("fills import/require from default, but never invents a types target", () => {
    const [entry] = collectExportEntries("@scope/pkg", { "./x": { default: "./dist/x.js" } });

    expect(entry?.targets).toEqual({ import: "./dist/x.js", require: "./dist/x.js" });
  });

  test("returns nothing when the package declares no exports", () => {
    expect(collectExportEntries("@scope/pkg", undefined)).toEqual([]);
  });
});

describe("specifierFor", () => {
  test("root subpath is the bare package name", () => {
    expect(specifierFor("@scope/pkg", ".")).toBe("@scope/pkg");
  });

  test("subpaths drop the leading ./", () => {
    expect(specifierFor("@scope/pkg", "./channels")).toBe("@scope/pkg/channels");
  });
});

describe("loadPlan", () => {
  function planFor(exportsMap: Record<string, unknown>) {
    const [entry] = collectExportEntries("@scope/pkg", exportsMap as never);
    if (!entry) throw new Error("expected an entry");
    return loadPlan(entry);
  }

  test("loads a dual-format module under both conditions", () => {
    const plan = planFor({ ".": { import: "./dist/index.mjs", require: "./dist/index.js" } });

    expect(plan).toEqual({ import: true, require: true });
  });

  test("recognises .cjs as a script", () => {
    expect(planFor({ "./x": { require: "./dist/x.cjs" } }).require).toBe(true);
  });

  test("loads JSON under require only — ESM would need an import attribute", () => {
    expect(planFor({ "./package.json": "./package.json" })).toEqual({
      import: false,
      require: true,
    });
  });

  test("never loads an asset subpath; its packed presence is the whole check", () => {
    expect(planFor({ "./client/style.css": "./dist/static/chatter.css" })).toEqual({
      import: false,
      require: false,
    });
  });
});

describe("missingTargets", () => {
  const entries = collectExportEntries("@scope/pkg", {
    "./server": {
      types: "./dist/server.d.ts",
      import: "./dist/server.mjs",
      require: "./dist/server.js",
    },
  });

  test("flags the runtime targets no build step produced, per condition", () => {
    // The exact shape of the bug this check exists for: types resolve, so
    // consumers compile, and only the runtime import blows up.
    const violations = missingTargets(entries, ["package/dist/server.d.ts"]);

    expect(violations.map((v) => v.condition).sort()).toEqual(["import", "require"]);
    expect(violations.every((v) => v.subpath === "./server")).toBe(true);
  });

  test("passes when every declared target is packed", () => {
    const files = ["dist/server.d.ts", "dist/server.mjs", "dist/server.js"];

    expect(missingTargets(entries, files)).toEqual([]);
  });
});

describe("hygieneViolations", () => {
  test("catches test declarations and fixtures anywhere in the tree", () => {
    const files = [
      "package/dist/index.d.ts",
      "package/dist/server.test.d.ts",
      "package/dist/server.test.d.ts.map",
      "package/dist/flows/__fixtures__/greeting/handler.d.ts",
    ];

    expect(hygieneViolations(files)).toEqual([
      "dist/server.test.d.ts",
      "dist/server.test.d.ts.map",
      "dist/flows/__fixtures__/greeting/handler.d.ts",
    ]);
  });

  test("does not mistake a shipped module for a test declaration", () => {
    expect(hygieneViolations(["dist/core/latest.d.ts", "dist/testing.d.ts"])).toEqual([]);
  });
});

describe("bundleSizeViolations", () => {
  const budgets = [
    { path: "dist/index.mjs", maxBytes: 100 },
    { path: "dist/index.js", maxBytes: 100 },
  ];

  test("passes when every budgeted path is within its limit", () => {
    const sizes = new Map([
      ["dist/index.mjs", 90],
      ["dist/index.js", 100],
    ]);

    expect(bundleSizeViolations(budgets, sizes)).toEqual([]);
  });

  test("reports each path that exceeds its budget", () => {
    const sizes = new Map([
      ["dist/index.mjs", 101],
      ["dist/index.js", 50],
    ]);

    expect(bundleSizeViolations(budgets, sizes)).toEqual([
      { path: "dist/index.mjs", maxBytes: 100, actualBytes: 101 },
    ]);
  });

  test("throws rather than silently pass when a budgeted path has no recorded size", () => {
    expect(() => bundleSizeViolations(budgets, new Map())).toThrow(
      /no size recorded for budgeted path "dist\/index\.mjs"/,
    );
  });
});
