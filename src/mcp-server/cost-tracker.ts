/**
 * Cost Tracking for OpenAI API Usage
 */

import type { CostInfo } from "./types";

/**
 * Calculate cost based on token usage
 * GPT-4o pricing as of 2024: $2.50 per 1M input tokens, $10.00 per 1M output tokens
 *
 * @param usage - Token usage from OpenAI API response
 * @returns Cost information including token counts and estimated USD cost
 */
export function calculateCost(usage: {
  prompt_tokens: number;
  completion_tokens: number;
}): CostInfo {
  const promptTokens = usage.prompt_tokens || 0;
  const completionTokens = usage.completion_tokens || 0;
  const totalTokens = promptTokens + completionTokens;

  // GPT-4o pricing: $2.50 per 1M input tokens, $10.00 per 1M output tokens
  const promptCost = (promptTokens / 1_000_000) * 2.5;
  const completionCost = (completionTokens / 1_000_000) * 10.0;
  const estimatedCost = promptCost + completionCost;

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    estimatedCost,
  };
}

/**
 * Format cost as a human-readable string
 *
 * @param cost - Cost information
 * @returns Formatted cost string (e.g., "$0.003670")
 */
export function formatCost(cost: CostInfo): string {
  return `$${cost.estimatedCost.toFixed(6)}`;
}

/**
 * Get cost summary for logging
 *
 * @param cost - Cost information
 * @returns Object with formatted cost data
 */
export function getCostSummary(cost: CostInfo) {
  return {
    promptTokens: cost.promptTokens,
    completionTokens: cost.completionTokens,
    totalTokens: cost.totalTokens,
    estimatedCostUSD: cost.estimatedCost,
    formatted: formatCost(cost),
  };
}
