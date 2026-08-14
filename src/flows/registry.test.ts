import { describe, expect, test } from "bun:test";
import { createFlowRegistry } from "./registry";
import type { LoadedFlow } from "./types";

function makeFlow(id: string): LoadedFlow {
  return {
    definition: {
      id,
      name: id,
      description: "test flow",
      triggerKeywords: [id],
      schema: { type: "object", properties: {}, required: [] },
    },
    handler: async () => ({ success: true, message: "ok" }),
    instructionsPath: `${import.meta.dir}/registry.test.ts`,
  };
}

describe("createFlowRegistry", () => {
  test("looks up flows by id", () => {
    const flow = makeFlow("testFlow");
    const registry = createFlowRegistry(new Map([["testFlow", flow]]));

    expect(registry.getFlow("testFlow")).toBe(flow);
    expect(registry.getFlow("missing")).toBeUndefined();
    expect(registry.getAllFlows()).toEqual([flow]);
  });

  test("reads instructions for a known flow and throws for an unknown one", () => {
    const flow = makeFlow("testFlow");
    const registry = createFlowRegistry(new Map([["testFlow", flow]]));

    expect(registry.getInstructions("testFlow")).toContain("registry.test.ts");
    expect(() => registry.getInstructions("missing")).toThrow("Flow missing not found");
  });

  test("matchByKeyword is case-insensitive and returns the mapped flow", () => {
    const transferFlow = makeFlow("transfer");
    const registry = createFlowRegistry(new Map([["transfer", transferFlow]]), {
      human: "transfer",
      agent: "transfer",
    });

    expect(registry.matchByKeyword("let me talk to a HUMAN please")).toBe(transferFlow);
    expect(registry.matchByKeyword("get me an agent")).toBe(transferFlow);
    expect(registry.matchByKeyword("what is the weather")).toBeUndefined();
  });

  test("matchByKeyword is disabled entirely with no criticalKeywords configured", () => {
    const flow = makeFlow("testFlow");
    const registry = createFlowRegistry(new Map([["testFlow", flow]]));

    expect(registry.matchByKeyword("testFlow please")).toBeUndefined();
  });

  test("matchByKeyword ignores a keyword mapped to a flow id that isn't loaded", () => {
    const registry = createFlowRegistry(new Map(), { human: "transfer" });

    expect(registry.matchByKeyword("get me a human")).toBeUndefined();
  });
});
