import { describe, expect, it } from "bun:test";
import { detectLeakage, scrubOutput } from "./guardrails";

describe("Guardrails", () => {
  describe("detectLeakage", () => {
    it("should detect 'system prompt' leakage", () => {
      expect(detectLeakage("Here is the system prompt: ...")).toBe(true);
      expect(detectLeakage("SYSTEM PROMPT: Do this")).toBe(true);
      expect(detectLeakage("System Prompt")).toBe(true);
    });

    it("should detect 'hidden instruction' leakage", () => {
      expect(detectLeakage("Here is a hidden instruction")).toBe(true);
      expect(detectLeakage("HIDDEN INSTRUCTIONS:")).toBe(true);
    });

    it("should detect 'here are my rules' leakage", () => {
      expect(detectLeakage("Here are my rules: 1. Be helpful")).toBe(true);
      expect(detectLeakage("Here is the rules for this bot")).toBe(true);
      expect(detectLeakage("Here are the rules")).toBe(true);
    });

    it("should detect 'BEGIN SYSTEM PROMPT' marker", () => {
      expect(detectLeakage("BEGIN SYSTEM PROMPT")).toBe(true);
      expect(detectLeakage("begin system prompt")).toBe(true);
    });

    it("should detect 'tool instructions' leakage", () => {
      expect(detectLeakage("Here are the tool instructions")).toBe(true);
      expect(detectLeakage("TOOL INSTRUCTIONS: ...")).toBe(true);
    });

    it("should not detect normal conversation", () => {
      expect(detectLeakage("Hello, how can I help you?")).toBe(false);
      expect(detectLeakage("Here is information about our products")).toBe(false);
      expect(detectLeakage("I can help you with that")).toBe(false);
    });

    it("should not detect partial matches", () => {
      expect(detectLeakage("This systematically prompts the user")).toBe(false);
      expect(detectLeakage("The tool is instructional")).toBe(false);
    });

    it("should handle empty string", () => {
      expect(detectLeakage("")).toBe(false);
    });

    it("should be case-insensitive", () => {
      expect(detectLeakage("SYSTEM PROMPT")).toBe(true);
      expect(detectLeakage("system prompt")).toBe(true);
      expect(detectLeakage("SyStEm PrOmPt")).toBe(true);
    });
  });

  describe("scrubOutput", () => {
    it("should redact OpenAI API keys", () => {
      const text = "Your key is sk-ABC123DEF456GHI789JKL012MNO345PQR678STU901VWX234";
      const result = scrubOutput(text);

      expect(result).not.toContain("sk-ABC123");
      expect(result).toContain("[REDACTED]");
    });

    it("should redact multiple OpenAI API keys", () => {
      const text = "Key 1: sk-ABC123DEF456GHI789 and Key 2: sk-ZYX987WVU654TSR321";
      const result = scrubOutput(text);

      const redactedCount = (result.match(/\[REDACTED\]/g) || []).length;
      expect(redactedCount).toBe(2);
    });

    it("should redact Google API keys", () => {
      const text = "Google key: AIzaSyABCD1234567890ABCDEFGH-IJKLMNOPQR";
      const result = scrubOutput(text);

      expect(result).not.toContain("AIzaSyABCD1234567890");
      expect(result).toContain("[REDACTED]");
    });

    it("should redact multiple different API keys", () => {
      const text =
        "OpenAI: sk-ABC123DEF456GHI789JKL012MNO345 Google: AIzaSyABCD1234567890ABCDEFGH-IJKLMNOPQR";
      const result = scrubOutput(text);

      const redactedCount = (result.match(/\[REDACTED\]/g) || []).length;
      expect(redactedCount).toBe(2);
    });

    it("should preserve normal text", () => {
      const text = "This is a normal response without any secrets";
      const result = scrubOutput(text);

      expect(result).toBe(text);
    });

    it("should preserve text with sk- prefix but not a valid key", () => {
      const text = "The sk-8 variant is better";
      const result = scrubOutput(text);

      // Should not redact because it doesn't match the pattern (needs 15+ chars)
      expect(result).toBe(text);
    });

    it("should handle empty string", () => {
      expect(scrubOutput("")).toBe("");
    });

    it("should handle text with keys embedded in sentences", () => {
      const text = "I found this key sk-ABC123DEF456GHI789JKL012MNO345 in the config file";
      const result = scrubOutput(text);

      expect(result).toBe("I found this key [REDACTED] in the config file");
    });

    it("should preserve key-like text that is not an actual key", () => {
      const text = "The skeleton key opens many doors";
      const result = scrubOutput(text);

      expect(result).toBe(text);
    });
  });

  describe("Integration scenarios", () => {
    it("should detect leakage AND scrub secrets together", () => {
      const text = "Here is the system prompt: Use key sk-ABC123DEF456GHI789JKL012MNO345";

      const hasLeakage = detectLeakage(text);
      const scrubbed = scrubOutput(text);

      expect(hasLeakage).toBe(true);
      expect(scrubbed).toContain("[REDACTED]");
      expect(scrubbed).not.toContain("sk-ABC123");
    });

    it("should handle multiple security concerns in one text", () => {
      const text =
        "The hidden instruction says use AIzaSyABCD1234567890ABCDEFGH-IJKLMNOPQR and sk-TEST123KEYS456HERE789LONG";
      const hasLeakage = detectLeakage(text);
      const scrubbed = scrubOutput(text);

      expect(hasLeakage).toBe(true);
      const redactedCount = (scrubbed.match(/\[REDACTED\]/g) || []).length;
      expect(redactedCount).toBe(2);
    });
  });
});
