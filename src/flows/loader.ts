/**
 * Directory-based flow loader.
 *
 * Discovers flow directories on disk and loads each one's contract. Kept
 * byte-for-byte compatible with the reference implementation's on-disk
 * shape, so existing flow directories load unchanged.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { FlowDefinition, FlowHandler, FlowPrefill, LoadedFlow } from "./types";

const SKIPPED_DIR_NAMES = new Set(["lib", "tests", "registry"]);

/** Loads every flow directory under `flowsDir`. A flow that fails to load is skipped, not fatal to the rest. */
export async function loadFlowsFromDirectory(flowsDir: string): Promise<Map<string, LoadedFlow>> {
  const flows = new Map<string, LoadedFlow>();

  if (!existsSync(flowsDir)) {
    console.warn(`[flows] directory does not exist: ${flowsDir}`);
    return flows;
  }

  const flowDirs = readdirSync(flowsDir, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .filter((dirent) => !SKIPPED_DIR_NAMES.has(dirent.name))
    .map((dirent) => dirent.name);

  for (const flowName of flowDirs) {
    try {
      flows.set(flowName, await loadFlow(flowsDir, flowName));
    } catch (error) {
      console.warn(
        `[flows] failed to load "${flowName}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return flows;
}

async function loadFlow(flowsDir: string, flowName: string): Promise<LoadedFlow> {
  // Resolve to an absolute path: dynamic import() treats a relative path like
  // "config/flows/x/handler.ts" as a bare module specifier (a package name),
  // which fails at runtime in bundled deployments even when existsSync passes.
  const flowPath = resolve(flowsDir, flowName);
  const definitionPath = join(flowPath, "flow.json");
  const instructionsPath = join(flowPath, "instructions.md");
  const handlerPath = join(flowPath, "handler.ts");

  if (!existsSync(definitionPath)) {
    throw new Error(`flow.json not found for ${flowName}`);
  }
  if (!existsSync(instructionsPath)) {
    throw new Error(`instructions.md not found for ${flowName}`);
  }
  if (!existsSync(handlerPath)) {
    throw new Error(`handler.ts not found for ${flowName}`);
  }

  const definition = JSON.parse(readFileSync(definitionPath, "utf-8")) as FlowDefinition;

  if (definition.id !== flowName) {
    throw new Error(`Flow id mismatch: ${definition.id} !== ${flowName}`);
  }
  if (!definition.triggerKeywords || definition.triggerKeywords.length === 0) {
    throw new Error(`Flow ${flowName} has no trigger keywords`);
  }
  if (!definition.schema || Object.keys(definition.schema.properties ?? {}).length === 0) {
    throw new Error(`Flow ${flowName} has no schema`);
  }

  const handlerModule = await import(handlerPath);
  const handler = handlerModule.execute as FlowHandler;
  if (typeof handler !== "function") {
    throw new Error(`Flow ${flowName} handler.ts must export an 'execute' function`);
  }

  const prefillPath = join(flowPath, "prefill.ts");
  let prefill: FlowPrefill | undefined;
  if (existsSync(prefillPath)) {
    const prefillModule = await import(prefillPath);
    if (typeof prefillModule.prefillFromContext === "function") {
      prefill = prefillModule.prefillFromContext as FlowPrefill;
    } else {
      console.warn(
        `[flows] "${flowName}" prefill.ts does not export a prefillFromContext function`,
      );
    }
  }

  return { definition, handler, instructionsPath, prefill };
}
