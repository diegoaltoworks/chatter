/**
 * Cost Tracking for OpenAI API Usage
 */

import type { CostInfo, PricingRates } from "./types";

/**
 * Calculate cost based on token usage.
 *
 * Pricing varies by model and changes over time, so this never guesses at
 * it: without `rates` the token counts are still reported but
 * `estimatedCost` is `null` rather than a number computed against a price
 * that may not match whatever model actually answered.
 *
 * @param usage - Token usage from OpenAI API response
 * @param rates - USD per 1M tokens, typically sourced from `config.openai.pricing`
 * @returns Cost information including token counts and estimated USD cost
 */
export function calculateCost(
  usage: { prompt_tokens: number; completion_tokens: number },
  rates?: PricingRates,
): CostInfo {
  const promptTokens = usage.prompt_tokens || 0;
  const completionTokens = usage.completion_tokens || 0;
  const totalTokens = promptTokens + completionTokens;

  const estimatedCost = rates
    ? (promptTokens / 1_000_000) * rates.promptPer1M +
      (completionTokens / 1_000_000) * rates.completionPer1M
    : null;

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
 * @returns Formatted cost string (e.g., "$0.003670"), or "tokens only" when no rates were configured
 */
export function formatCost(cost: CostInfo): string {
  return cost.estimatedCost === null ? "tokens only" : `$${cost.estimatedCost.toFixed(6)}`;
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
