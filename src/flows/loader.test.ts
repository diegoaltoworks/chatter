/**
 * Loader tests — verifies flow directories load per the reference
 * implementation's on-disk contract (flow.json/handler.{ts,js,mjs}/
 * instructions.md, optional prefill.ts), that flow.json is validated against
 * the versioned contract, and that a malformed directory is skipped rather
 * than failing the whole load.
 */

import { describe, expect, test } from "bun:test";
import type { Logger } from "../core/logger";
import { loadFlowsFromDirectory } from "./loader";

const FIXTURES_DIR = `${import.meta.dir}/__fixtures__`;

/** Captures warn() calls so tests can assert on the actual message, not just pass/fail. */
function capturingLogger(): { logger: Logger; warnings: string[] } {
  const warnings: string[] = [];
  const noop = () => {};
  return {
    logger: {
      debug: noop,
      info: noop,
      error: noop,
      warn: (...args: unknown[]) => warnings.push(args.join(" ")),
    },
    warnings,
  };
}

describe("loadFlowsFromDirectory", () => {
  test("loads an existing flow directory unchanged", async () => {
    const flows = await loadFlowsFromDirectory(FIXTURES_DIR);
    const greeting = flows.get("greeting");

    expect(greeting).toBeDefined();
    expect(greeting?.definition.id).toBe("greeting");
    expect(greeting?.definition.triggerKeywords).toEqual(["hello", "hi"]);
    expect(greeting?.definition.schema.required).toEqual(["name"]);
    expect(typeof greeting?.handler).toBe("function");
    expect(greeting?.instructionsPath).toContain("instructions.md");
    expect(typeof greeting?.prefill).toBe("function");
  });

  test("runs the loaded handler and prefill", async () => {
    const flows = await loadFlowsFromDirectory(FIXTURES_DIR);
    const greeting = flows.get("greeting");

    expect(greeting?.prefill?.("session-1", { name: "Ada" })).toEqual({ name: "Ada" });
    const result = await greeting?.handler({ name: "Ada" }, { sessionKey: "session-1" });
    expect(result).toEqual({ success: true, message: "Hello, Ada!", result: { name: "Ada" } });
  });

  test("skips a directory whose flow.json id does not match its folder name", async () => {
    const flows = await loadFlowsFromDirectory(FIXTURES_DIR);

    expect(flows.has("broken")).toBe(false);
    expect(flows.has("not-broken")).toBe(false);
  });

  test("returns an empty map for a missing directory", async () => {
    const flows = await loadFlowsFromDirectory(`${FIXTURES_DIR}/does-not-exist`);
    expect(flows.size).toBe(0);
  });

  test("defaults contractVersion to 1 when flow.json omits it", async () => {
    const flows = await loadFlowsFromDirectory(FIXTURES_DIR);
    expect(flows.get("greeting")?.definition.contractVersion).toBe(1);
  });

  test("loads an explicit contractVersion", async () => {
    const flows = await loadFlowsFromDirectory(FIXTURES_DIR);
    expect(flows.get("versioned")?.definition.contractVersion).toBe(1);
  });

  test("skips a flow whose contractVersion is newer than this loader understands, with an actionable warning", async () => {
    const { logger, warnings } = capturingLogger();
    const flows = await loadFlowsFromDirectory(FIXTURES_DIR, logger);

    expect(flows.has("futureContract")).toBe(false);
    expect(
      warnings.some((w) => w.includes("futureContract") && w.includes("contractVersion")),
    ).toBe(true);
  });

  test("falls back to handler.js when handler.ts is absent", async () => {
    const flows = await loadFlowsFromDirectory(FIXTURES_DIR);
    const jsHandler = flows.get("jsHandler");

    expect(jsHandler).toBeDefined();
    const result = await jsHandler?.handler({}, { sessionKey: "session-1" });
    expect(result).toEqual({ success: true, message: "from js" });
  });

  test("falls back to handler.mjs when neither handler.ts nor handler.js exist", async () => {
    const flows = await loadFlowsFromDirectory(FIXTURES_DIR);
    const mjsHandler = flows.get("mjsHandler");

    expect(mjsHandler).toBeDefined();
    const result = await mjsHandler?.handler({}, { sessionKey: "session-1" });
    expect(result).toEqual({ success: true, message: "from mjs" });
  });

  test("prefers handler.ts over handler.js when both exist", async () => {
    const flows = await loadFlowsFromDirectory(FIXTURES_DIR);
    const result = await flows.get("dualHandler")?.handler({}, { sessionKey: "session-1" });
    expect(result).toEqual({ success: true, message: "from ts" });
  });

  test("falls back to prefill.js when prefill.ts is absent", async () => {
    const flows = await loadFlowsFromDirectory(FIXTURES_DIR);
    expect(flows.get("jsHandler")?.prefill?.("session-1", { seeded: true })).toEqual({
      seeded: true,
    });
  });
});
