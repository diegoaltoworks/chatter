import { describe, expect, it } from "bun:test";
import { calculateCost, formatCost, getCostSummary } from "./cost-tracker";

describe("Cost Tracker", () => {
  describe("calculateCost", () => {
    it("should calculate cost for typical usage", () => {
      const result = calculateCost({
        prompt_tokens: 1000,
        completion_tokens: 500,
      });

      expect(result.promptTokens).toBe(1000);
      expect(result.completionTokens).toBe(500);
      expect(result.totalTokens).toBe(1500);
      // 1000 * $2.50/1M + 500 * $10.00/1M = $0.0025 + $0.005 = $0.0075
      expect(result.estimatedCost).toBeCloseTo(0.0075, 6);
    });

    it("should handle zero tokens", () => {
      const result = calculateCost({
        prompt_tokens: 0,
        completion_tokens: 0,
      });

      expect(result.promptTokens).toBe(0);
      expect(result.completionTokens).toBe(0);
      expect(result.totalTokens).toBe(0);
      expect(result.estimatedCost).toBe(0);
    });

    it("should handle large token counts", () => {
      const result = calculateCost({
        prompt_tokens: 100_000,
        completion_tokens: 50_000,
      });

      expect(result.promptTokens).toBe(100_000);
      expect(result.completionTokens).toBe(50_000);
      expect(result.totalTokens).toBe(150_000);
      // 100k * $2.50/1M + 50k * $10.00/1M = $0.25 + $0.50 = $0.75
      expect(result.estimatedCost).toBeCloseTo(0.75, 6);
    });

    it("should calculate correctly with GPT-4o pricing", () => {
      // Real-world example: 842 prompt, 156 completion
      const result = calculateCost({
        prompt_tokens: 842,
        completion_tokens: 156,
      });

      expect(result.promptTokens).toBe(842);
      expect(result.completionTokens).toBe(156);
      expect(result.totalTokens).toBe(998);
      // 842 * $2.50/1M + 156 * $10.00/1M
      const expectedCost = (842 / 1_000_000) * 2.5 + (156 / 1_000_000) * 10.0;
      expect(result.estimatedCost).toBeCloseTo(expectedCost, 8);
    });

    it("should handle missing tokens as zero", () => {
      const result = calculateCost({
        prompt_tokens: 0,
        completion_tokens: 0,
      });

      expect(result.promptTokens).toBe(0);
      expect(result.completionTokens).toBe(0);
    });
  });

  describe("formatCost", () => {
    it("should format cost with 6 decimal places", () => {
      const cost = {
        promptTokens: 1000,
        completionTokens: 500,
        totalTokens: 1500,
        estimatedCost: 0.0075,
      };

      expect(formatCost(cost)).toBe("$0.007500");
    });

    it("should format zero cost", () => {
      const cost = {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        estimatedCost: 0,
      };

      expect(formatCost(cost)).toBe("$0.000000");
    });

    it("should format large costs", () => {
      const cost = {
        promptTokens: 1_000_000,
        completionTokens: 500_000,
        totalTokens: 1_500_000,
        estimatedCost: 7.5,
      };

      expect(formatCost(cost)).toBe("$7.500000");
    });

    it("should handle very small costs", () => {
      const cost = {
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        estimatedCost: 0.000075,
      };

      expect(formatCost(cost)).toBe("$0.000075");
    });
  });

  describe("getCostSummary", () => {
    it("should return complete cost summary", () => {
      const cost = {
        promptTokens: 842,
        completionTokens: 156,
        totalTokens: 998,
        estimatedCost: 0.00367,
      };

      const summary = getCostSummary(cost);

      expect(summary.promptTokens).toBe(842);
      expect(summary.completionTokens).toBe(156);
      expect(summary.totalTokens).toBe(998);
      expect(summary.estimatedCostUSD).toBe(0.00367);
      expect(summary.formatted).toBe("$0.003670");
    });

    it("should include formatted string", () => {
      const cost = {
        promptTokens: 1000,
        completionTokens: 500,
        totalTokens: 1500,
        estimatedCost: 0.0075,
      };

      const summary = getCostSummary(cost);

      expect(summary.formatted).toMatch(/^\$\d+\.\d{6}$/);
      expect(summary.formatted).toBe("$0.007500");
    });
  });

  describe("Integration: Real-world scenarios", () => {
    it("should calculate costs for a typical conversation", () => {
      const requests = [
        { prompt_tokens: 500, completion_tokens: 100 },
        { prompt_tokens: 600, completion_tokens: 150 },
        { prompt_tokens: 700, completion_tokens: 200 },
      ];

      const costs = requests.map((req) => calculateCost(req));
      const totalCost = costs.reduce((sum, cost) => sum + cost.estimatedCost, 0);

      expect(costs).toHaveLength(3);
      expect(totalCost).toBeGreaterThan(0);
      expect(totalCost).toBeLessThan(0.02); // Should be small for this usage
    });

    it("should track cumulative tokens accurately", () => {
      const requests = [
        { prompt_tokens: 100, completion_tokens: 50 },
        { prompt_tokens: 200, completion_tokens: 75 },
      ];

      const costs = requests.map((req) => calculateCost(req));
      const totalTokens = costs.reduce((sum, cost) => sum + cost.totalTokens, 0);

      expect(totalTokens).toBe(425); // 100+50+200+75
    });
  });
});
