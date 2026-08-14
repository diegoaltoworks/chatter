/**
 * Flow registry — lookup and the pure (non-LLM) half of matching.
 *
 * Framework-free: holds loaded flows and answers keyword lookups
 * synchronously. LLM-based intent matching lives in `./intent` and is
 * orchestrated by `./engine`, which is what decides whether the keyword step
 * or the LLM step wins.
 */

import { readFileSync } from "node:fs";
import type { LoadedFlow } from "./types";

export interface FlowRegistry {
  getFlow(id: string): LoadedFlow | undefined;
  getAllFlows(): LoadedFlow[];
  getInstructions(id: string): string;
  /**
   * Immediate, deterministic trigger: the first configured keyword found in
   * `message` (case-insensitive substring match) wins over LLM intent
   * detection. Empty/unset `criticalKeywords` disables this step entirely.
   */
  matchByKeyword(message: string): LoadedFlow | undefined;
}

export function createFlowRegistry(
  flows: Map<string, LoadedFlow>,
  criticalKeywords: Record<string, string> = {},
): FlowRegistry {
  const keywordEntries = Object.entries(criticalKeywords);

  return {
    getFlow(id) {
      return flows.get(id);
    },
    getAllFlows() {
      return Array.from(flows.values());
    },
    getInstructions(id) {
      const flow = flows.get(id);
      if (!flow) {
        throw new Error(`Flow ${id} not found`);
      }
      return readFileSync(flow.instructionsPath, "utf-8");
    },
    matchByKeyword(message) {
      const lowerMessage = message.toLowerCase();
      for (const [keyword, flowId] of keywordEntries) {
        if (lowerMessage.includes(keyword.toLowerCase())) {
          const flow = flows.get(flowId);
          if (flow) return flow;
        }
      }
      return undefined;
    },
  };
}
