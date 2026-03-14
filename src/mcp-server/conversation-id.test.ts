import { describe, expect, it } from "bun:test";
import {
  generateConversationId,
  getOrGenerateConversationId,
  isValidConversationId,
} from "./conversation-id";

describe("Conversation ID", () => {
  describe("generateConversationId", () => {
    it("should generate ID with correct format", () => {
      const id = generateConversationId();
      expect(id).toMatch(/^conv_\d+_[a-z0-9]+$/);
    });

    it("should generate unique IDs", () => {
      const id1 = generateConversationId();
      const id2 = generateConversationId();
      expect(id1).not.toBe(id2);
    });

    it("should include timestamp", () => {
      const before = Date.now();
      const id = generateConversationId();
      const after = Date.now();

      const timestamp = Number.parseInt(id.split("_")[1]);
      expect(timestamp).toBeGreaterThanOrEqual(before);
      expect(timestamp).toBeLessThanOrEqual(after);
    });

    it("should include random component", () => {
      const id = generateConversationId();
      const parts = id.split("_");
      expect(parts).toHaveLength(3);
      expect(parts[2]).toHaveLength(9);
    });
  });

  describe("getOrGenerateConversationId", () => {
    it("should return provided ID when given", () => {
      const providedId = "my-custom-id";
      const result = getOrGenerateConversationId(providedId);
      expect(result).toBe(providedId);
    });

    it("should generate new ID when undefined", () => {
      const result = getOrGenerateConversationId(undefined);
      expect(result).toMatch(/^conv_\d+_[a-z0-9]+$/);
    });

    it("should preserve empty string", () => {
      const result = getOrGenerateConversationId("");
      expect(result).toMatch(/^conv_\d+_[a-z0-9]+$/);
    });

    it("should handle various custom ID formats", () => {
      const customIds = ["session-123", "user_456", "conv_custom_abc", "12345"];

      for (const customId of customIds) {
        const result = getOrGenerateConversationId(customId);
        expect(result).toBe(customId);
      }
    });
  });

  describe("isValidConversationId", () => {
    it("should validate generated IDs", () => {
      const id = generateConversationId();
      expect(isValidConversationId(id)).toBe(true);
    });

    it("should validate custom IDs", () => {
      expect(isValidConversationId("my-custom-id")).toBe(true);
      expect(isValidConversationId("123")).toBe(true);
      expect(isValidConversationId("conv_abc_xyz")).toBe(true);
    });

    it("should reject empty strings", () => {
      expect(isValidConversationId("")).toBe(false);
    });

    it("should reject non-strings", () => {
      // Testing runtime behavior with invalid types
      expect(isValidConversationId(null as unknown as string)).toBe(false);
      expect(isValidConversationId(undefined as unknown as string)).toBe(false);
      expect(isValidConversationId(123 as unknown as string)).toBe(false);
    });

    it("should accept IDs with special characters", () => {
      expect(isValidConversationId("id-with-dashes")).toBe(true);
      expect(isValidConversationId("id_with_underscores")).toBe(true);
      expect(isValidConversationId("id.with.dots")).toBe(true);
    });
  });
});
