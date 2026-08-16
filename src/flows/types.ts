/**
 * Flow engine types.
 *
 * A flow is a directory-loaded contract: `flow.json` (id/name/description/
 * triggerKeywords/schema), `handler.ts` (an `execute` export) and
 * `instructions.md` (the prompt fed to parameter extraction), with an
 * optional `prefill.ts` (`prefillFromContext` export). A stable on-disk
 * contract, versioned via `contractVersion` below.
 */

export interface FlowSchemaProperty {
  type: "string" | "number" | "boolean";
  description?: string;
}

export interface FlowSchema {
  type: "object";
  properties: Record<string, FlowSchemaProperty>;
  required: string[];
}

/**
 * Highest `contractVersion` this loader understands. A flow.json omitting
 * `contractVersion` is treated as version 1 (every flow written before this
 * field existed); a flow.json naming a version above this one fails to load
 * with an actionable error rather than being silently misinterpreted.
 */
export const CURRENT_FLOW_CONTRACT_VERSION = 1;

/** Parsed `flow.json`. */
export interface FlowDefinition {
  id: string;
  name: string;
  description: string;
  triggerKeywords: string[];
  schema: FlowSchema;
  /** Defaults to 1 when omitted. See {@link CURRENT_FLOW_CONTRACT_VERSION}. */
  contractVersion?: number;
}

/** What a handler is given alongside the collected params. */
export interface FlowHandlerContext {
  /** Caller-chosen id for this conversation — a phone number, a WhatsApp JID, a web session id. Channel-agnostic by design. */
  sessionKey: string;
  /** Free-form channel label, when the caller knows one. Not interpreted by the engine. */
  channel?: string;
}

/**
 * What a flow hands back once its params are complete.
 *
 * Deliberately presentation-free: no per-channel text. A flow returns one
 * message plus a structured `result`; rendering it for voice, SMS, WhatsApp
 * or anything else is the calling plugin's job, not the engine's.
 */
export interface FlowHandlerResult {
  /**
   * Whether the flow itself completed successfully. `success: false` is for
   * "something went wrong that the caller should treat generically" — a flow
   * that wants its own in-persona message for an expected failure (validation,
   * a caught upstream error) should still report `success: true`.
   */
  success: boolean;
  message: string;
  result?: unknown;
}

export type FlowHandler = (
  params: Record<string, unknown>,
  context: FlowHandlerContext,
) => Promise<FlowHandlerResult>;

/** Seeds params from context before extraction runs — e.g. a caller id already known from the channel. */
export type FlowPrefill = (
  sessionKey: string,
  context: Record<string, unknown>,
) => Record<string, unknown>;

export interface LoadedFlow {
  definition: FlowDefinition;
  handler: FlowHandler;
  instructionsPath: string;
  prefill?: FlowPrefill;
}

export interface FlowExtractionResult {
  extractedParams: Record<string, unknown>;
  allParamsFilled: boolean;
  nextPrompt?: string;
}

export interface IntentDetection {
  intent: string;
  confidence: number;
  reasoning?: string;
}

/** Multi-turn state persisted between messages while a flow is collecting params. */
export interface FlowSessionState {
  flowId: string;
  params: Record<string, unknown>;
  attempts: number;
  startedAt: number;
}

/**
 * Structural dependency for session persistence — a host supplies an
 * implementation (see `./session` for the shipped Turso binding). Must be
 * safe under a multi-instance deployment: state written by one instance has
 * to be visible to whichever instance handles the next message.
 */
export interface FlowSessionStore {
  get(sessionKey: string): Promise<FlowSessionState | null>;
  set(sessionKey: string, state: FlowSessionState): Promise<void>;
  clear(sessionKey: string): Promise<void>;
}

export interface FlowResult {
  isFlowActive: boolean;
  message: string;
  flowCompleted: boolean;
  flowSuccess?: boolean;
  result?: unknown;
  /** The caller cancelled an active flow. */
  cancelled?: boolean;
  /** Flow processing failed (registry lookup, parameter extraction, or handler). */
  error?: boolean;
}
