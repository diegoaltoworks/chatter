/**
 * Loader tests — verifies flow directories load per the reference
 * implementation's on-disk contract (flow.json/handler.ts/instructions.md,
 * optional prefill.ts), and that a malformed directory is skipped rather
 * than failing the whole load.
 */

import { describe, expect, test } from "bun:test";
import { loadFlowsFromDirectory } from "./loader";

const FIXTURES_DIR = `${import.meta.dir}/__fixtures__`;

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
});
