/**
 * Flow engine — directory-loaded, schema-driven slot-filling flows with
 * hybrid (keyword + LLM) intent matching and multi-instance-safe session
 * state. Published as the `@diegoaltoworks/chatter/flows` subpath so the
 * core install stays untouched by it.
 *
 * Presentation stays out: `process()` returns a structured {@link FlowResult}
 * ({@link FlowHandlerResult.message} plus an optional `result` payload) —
 * rendering it for voice, SMS, WhatsApp or anything else is the calling
 * plugin's job. This module is the designated future home for graph-based
 * orchestration.
 *
 * @packageDocumentation
 */

export type { FlowEngine, FlowEngineOptions } from "./engine";
export { createFlowEngine } from "./engine";
export { detectIntent } from "./intent";
export { loadFlowsFromDirectory } from "./loader";
export { extractParameters } from "./params";
export type { FlowRegistry } from "./registry";
export { createFlowRegistry } from "./registry";
export { createTursoFlowSessionStore } from "./session";
export type {
  FlowDefinition,
  FlowExtractionResult,
  FlowHandler,
  FlowHandlerContext,
  FlowHandlerResult,
  FlowPrefill,
  FlowResult,
  FlowSchema,
  FlowSchemaProperty,
  FlowSessionState,
  FlowSessionStore,
  IntentDetection,
  LoadedFlow,
} from "./types";
export { CURRENT_FLOW_CONTRACT_VERSION } from "./types";
export { shouldExitFlow } from "./utils";
