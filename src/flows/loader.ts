/**
 * Directory-based flow loader.
 *
 * Discovers flow directories on disk and loads each one's contract, validated
 * against the versioned flow.json contract (see {@link CURRENT_FLOW_CONTRACT_VERSION}
 * in ./types).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createConsoleLogger, type Logger } from "../core/logger";
import type { FlowDefinition, FlowHandler, FlowPrefill, LoadedFlow } from "./types";
import { CURRENT_FLOW_CONTRACT_VERSION } from "./types";

const SKIPPED_DIR_NAMES = new Set(["lib", "tests", "registry"]);

/** Extensions probed for a flow's handler/prefill module, in priority order. */
const MODULE_EXTENSIONS = ["ts", "js", "mjs"];

/** Loads every flow directory under `flowsDir`. A flow that fails to load is skipped, not fatal to the rest. */
export async function loadFlowsFromDirectory(
  flowsDir: string,
  logger: Logger = createConsoleLogger(),
): Promise<Map<string, LoadedFlow>> {
  const flows = new Map<string, LoadedFlow>();

  if (!existsSync(flowsDir)) {
    logger.warn(`[flows] directory does not exist: ${flowsDir}`);
    return flows;
  }

  const flowDirs = readdirSync(flowsDir, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .filter((dirent) => !SKIPPED_DIR_NAMES.has(dirent.name))
    .map((dirent) => dirent.name);

  for (const flowName of flowDirs) {
    try {
      flows.set(flowName, await loadFlow(flowsDir, flowName, logger));
    } catch (error) {
      logger.warn(
        `[flows] failed to load "${flowName}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return flows;
}

/**
 * Validates the parsed flow.json against the fields the engine actually
 * reads (see ./params.ts, ./intent.ts). Deliberately no stricter than that:
 * `schema.required` and `schema.type` are read with fallbacks elsewhere, and
 * property `type` is only ever interpolated into prompt text, so none of
 * those are enforced here — tightening them would silently drop flow.json
 * files that worked before this validation existed.
 */
function validateFlowDefinition(raw: unknown, flowName: string): asserts raw is FlowDefinition {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`flow.json for "${flowName}" must be a JSON object`);
  }
  const definition = raw as Partial<FlowDefinition>;

  if (typeof definition.id !== "string" || definition.id.length === 0) {
    throw new Error(`flow.json for "${flowName}": "id" must be a non-empty string`);
  }
  if (!Array.isArray(definition.triggerKeywords) || definition.triggerKeywords.length === 0) {
    throw new Error(`flow.json for "${flowName}": "triggerKeywords" must be a non-empty array`);
  }
  const properties = definition.schema?.properties;
  if (
    !properties ||
    typeof properties !== "object" ||
    Array.isArray(properties) ||
    Object.keys(properties).length === 0
  ) {
    throw new Error(`flow.json for "${flowName}": "schema.properties" must be a non-empty object`);
  }
  if (definition.contractVersion !== undefined) {
    const version = definition.contractVersion;
    if (!Number.isInteger(version) || version < 1 || version > CURRENT_FLOW_CONTRACT_VERSION) {
      throw new Error(
        `flow.json for "${flowName}": "contractVersion" ${JSON.stringify(version)} is not supported ` +
          `(this loader understands versions 1 through ${CURRENT_FLOW_CONTRACT_VERSION})`,
      );
    }
  }
}

async function loadFlow(flowsDir: string, flowName: string, logger: Logger): Promise<LoadedFlow> {
  // Resolve to an absolute path: dynamic import() treats a relative path like
  // "config/flows/x/handler.ts" as a bare module specifier (a package name),
  // which fails at runtime in bundled deployments even when existsSync passes.
  const flowPath = resolve(flowsDir, flowName);
  const definitionPath = join(flowPath, "flow.json");
  const instructionsPath = join(flowPath, "instructions.md");

  if (!existsSync(definitionPath)) {
    throw new Error(`flow.json not found for ${flowName} (looked for ${definitionPath})`);
  }
  if (!existsSync(instructionsPath)) {
    throw new Error(`instructions.md not found for ${flowName} (looked for ${instructionsPath})`);
  }

  const handlerPath = findModulePath(flowPath, "handler");
  if (!handlerPath) {
    const candidates = MODULE_EXTENSIONS.map((ext) => join(flowPath, `handler.${ext}`)).join(", ");
    throw new Error(`no handler found for ${flowName} (looked for ${candidates})`);
  }

  const rawDefinition = JSON.parse(readFileSync(definitionPath, "utf-8"));
  validateFlowDefinition(rawDefinition, flowName);
  const definition: FlowDefinition = {
    ...rawDefinition,
    contractVersion: rawDefinition.contractVersion ?? CURRENT_FLOW_CONTRACT_VERSION,
  };

  if (definition.id !== flowName) {
    throw new Error(`Flow id mismatch: ${definition.id} !== ${flowName}`);
  }

  const handlerModule = await import(handlerPath);
  const handler = handlerModule.execute as FlowHandler;
  if (typeof handler !== "function") {
    throw new Error(`Flow ${flowName} ${basename(handlerPath)} must export an 'execute' function`);
  }

  const prefillPath = findModulePath(flowPath, "prefill");
  let prefill: FlowPrefill | undefined;
  if (prefillPath) {
    const prefillModule = await import(prefillPath);
    if (typeof prefillModule.prefillFromContext === "function") {
      prefill = prefillModule.prefillFromContext as FlowPrefill;
    } else {
      logger.warn(
        `[flows] "${flowName}" ${basename(prefillPath)} does not export a prefillFromContext function`,
      );
    }
  }

  return { definition, handler, instructionsPath, prefill };
}

/** Probes `{base}.{ts,js,mjs}` in priority order; returns the first that exists, or `undefined`. */
function findModulePath(flowPath: string, base: string): string | undefined {
  for (const ext of MODULE_EXTENSIONS) {
    const candidate = join(flowPath, `${base}.${ext}`);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}
