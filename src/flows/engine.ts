/**
 * Flow engine — orchestrates the flow lifecycle: triggering, multi-turn
 * parameter collection, execution and cancellation. Channel-agnostic: it
 * takes a caller-chosen `sessionKey` and returns structured results, never
 * channel-specific presentation (see {@link FlowHandlerResult}).
 */

import type OpenAI from "openai";
import { detectIntent } from "./intent";
import { loadFlowsFromDirectory } from "./loader";
import { extractParameters } from "./params";
import { createFlowRegistry, type FlowRegistry } from "./registry";
import type { FlowResult, FlowSessionStore, LoadedFlow } from "./types";
import { shouldExitFlow } from "./utils";

export interface FlowEngineOptions {
  /** OpenAI client used for intent detection and parameter extraction. */
  client: OpenAI;
  /** Model for both LLM calls. */
  model: string;
  /** Directory containing flow subdirectories (flow.json/handler.ts/instructions.md). */
  flowsDir: string;
  /** Session persistence — see `./session` for the shipped Turso-backed store. */
  sessionStore: FlowSessionStore;
  /**
   * Keyword -> flow id map checked before LLM intent detection. Unset
   * disables the keyword-trigger step entirely (LLM detection only).
   */
  criticalKeywords?: Record<string, string>;
  /** Confidence threshold an LLM detection must clear to trigger a flow. Default 0.7. */
  minConfidence?: number;
  /** Phrases that cancel an active flow. Default: cancel/nevermind/stop/"forget it"/quit. */
  cancelKeywords?: string[];
  /** Message returned when a flow is cancelled. */
  cancelMessage?: string;
  /** Message returned when flow processing errors out. */
  errorMessage?: string;
  /**
   * How long an inactive session may sit before it's treated as abandoned
   * and dropped rather than resumed. Unset: sessions never expire on their
   * own (only completion or a cancel keyword clears one).
   */
  sessionTtlMs?: number;
  /** Clock, injectable for deterministic tests. */
  now?: () => number;
}

export interface FlowEngine {
  /** Loads (or reloads) every flow directory under `flowsDir`. */
  loadFlows(): Promise<void>;
  getFlow(id: string): LoadedFlow | undefined;
  getAllFlows(): LoadedFlow[];
  /** Advances (or starts) the flow for `sessionKey` given the caller's latest message. */
  process(
    sessionKey: string,
    message: string,
    options?: {
      conversationContext?: string[];
      channel?: string;
      /** Passed through to a freshly-triggered flow's `prefill`, when it has one. */
      prefillContext?: Record<string, unknown>;
    },
  ): Promise<FlowResult>;
}

const DEFAULT_MIN_CONFIDENCE = 0.7;
const DEFAULT_CANCEL_MESSAGE = "Okay, cancelled.";
const DEFAULT_ERROR_MESSAGE = "Sorry, something went wrong. Please try again.";

export function createFlowEngine(options: FlowEngineOptions): FlowEngine {
  const {
    client,
    model,
    flowsDir,
    sessionStore,
    criticalKeywords,
    minConfidence = DEFAULT_MIN_CONFIDENCE,
    cancelKeywords,
    cancelMessage = DEFAULT_CANCEL_MESSAGE,
    errorMessage = DEFAULT_ERROR_MESSAGE,
    sessionTtlMs,
    now = Date.now,
  } = options;

  let registry: FlowRegistry = createFlowRegistry(new Map());

  async function matchFlow(
    message: string,
    conversationContext?: string[],
  ): Promise<LoadedFlow | undefined> {
    const byKeyword = registry.matchByKeyword(message);
    if (byKeyword) return byKeyword;

    const allFlows = registry.getAllFlows();
    if (allFlows.length === 0) return undefined;

    const flowMap = new Map(allFlows.map((flow) => [flow.definition.id, flow]));
    const detection = await detectIntent(client, model, message, flowMap, conversationContext);
    if (detection.confidence >= minConfidence) {
      return registry.getFlow(detection.intent);
    }
    return undefined;
  }

  async function runToCompletionOrPrompt(
    flow: LoadedFlow,
    sessionKey: string,
    message: string,
    existingParams: Record<string, unknown>,
    attempts: number,
    startedAt: number,
    channel?: string,
  ): Promise<FlowResult> {
    const extraction = await extractParameters(client, model, flow, message, existingParams, now);
    const mergedParams = { ...existingParams, ...extraction.extractedParams };

    if (extraction.allParamsFilled) {
      const result = await flow.handler(mergedParams, { sessionKey, channel });
      await sessionStore.clear(sessionKey);
      return {
        isFlowActive: false,
        message: result.message,
        flowCompleted: true,
        flowSuccess: result.success,
        result: result.result,
      };
    }

    await sessionStore.set(sessionKey, {
      flowId: flow.definition.id,
      params: mergedParams,
      attempts: attempts + 1,
      startedAt,
    });
    return {
      isFlowActive: true,
      message: extraction.nextPrompt || "Could you provide more details?",
      flowCompleted: false,
    };
  }

  return {
    async loadFlows() {
      const flows = await loadFlowsFromDirectory(flowsDir);
      registry = createFlowRegistry(flows, criticalKeywords);
    },

    getFlow(id) {
      return registry.getFlow(id);
    },

    getAllFlows() {
      return registry.getAllFlows();
    },

    async process(sessionKey, message, processOptions) {
      const channel = processOptions?.channel;
      let activeSession = await sessionStore.get(sessionKey);

      if (
        activeSession &&
        sessionTtlMs !== undefined &&
        now() - activeSession.startedAt > sessionTtlMs
      ) {
        await sessionStore.clear(sessionKey);
        activeSession = null;
      }

      if (activeSession && shouldExitFlow(message, cancelKeywords)) {
        await sessionStore.clear(sessionKey);
        return {
          isFlowActive: false,
          message: cancelMessage,
          flowCompleted: false,
          cancelled: true,
        };
      }

      if (activeSession) {
        const flow = registry.getFlow(activeSession.flowId);
        if (!flow) {
          await sessionStore.clear(sessionKey);
          return { isFlowActive: false, message: errorMessage, flowCompleted: false, error: true };
        }
        try {
          return await runToCompletionOrPrompt(
            flow,
            sessionKey,
            message,
            activeSession.params,
            activeSession.attempts,
            activeSession.startedAt,
            channel,
          );
        } catch {
          // Params collected so far are left in the store rather than
          // discarded: a transient extraction/handler failure (one flaky
          // completion call) should cost the user a retry, not everything
          // they already told the flow. A cancel keyword or, if configured,
          // sessionTtlMs are still the way out of a session stuck failing.
          return { isFlowActive: true, message: errorMessage, flowCompleted: false, error: true };
        }
      }

      const matched = await matchFlow(message, processOptions?.conversationContext);
      if (!matched) {
        return { isFlowActive: false, message: "", flowCompleted: false };
      }

      try {
        const globalParams = matched.prefill
          ? matched.prefill(sessionKey, processOptions?.prefillContext ?? {})
          : {};
        return await runToCompletionOrPrompt(
          matched,
          sessionKey,
          message,
          globalParams,
          0,
          now(),
          channel,
        );
      } catch {
        // Nothing is persisted here on failure (a session is only written
        // inside runToCompletionOrPrompt after a successful extraction), so
        // there is no state to clean up — the next message simply retries
        // matching from scratch.
        return { isFlowActive: false, message: errorMessage, flowCompleted: false, error: true };
      }
    },
  };
}
