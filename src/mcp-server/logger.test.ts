import { describe, expect, it, mock } from "bun:test";
import type { Logger } from "../core/logger";
import { createLogger, MCPLogger } from "./logger";
import type { CostInfo, MCPLogCallback } from "./types";

function fakeLogger(): { logger: Logger; infoCalls: unknown[][]; errorCalls: unknown[][] } {
  const infoCalls: unknown[][] = [];
  const errorCalls: unknown[][] = [];
  return {
    logger: {
      debug() {},
      info: (...args) => infoCalls.push(args),
      warn() {},
      error: (...args) => errorCalls.push(args),
    },
    infoCalls,
    errorCalls,
  };
}

describe("MCPLogger", () => {
  describe("logChatInteraction", () => {
    it("should log to console when enabled", async () => {
      const { logger: fake, infoCalls } = fakeLogger();
      const logger = new MCPLogger(true, undefined, fake);
      const cost: CostInfo = {
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        estimatedCost: 0.001,
      };

      await logger.logChatInteraction(
        "test_tool",
        "conv_123",
        [{ role: "user", content: "test message" }],
        ["context1"],
        "response",
        1000,
        cost,
      );

      expect(infoCalls).toHaveLength(1);
      const loggedData = JSON.parse(infoCalls[0]?.[0] as string);
      expect(loggedData.event).toBe("mcp_chat");
      expect(loggedData.toolName).toBe("test_tool");
      expect(loggedData.conversationId).toBe("conv_123");
    });

    it("should not log to console when disabled", async () => {
      const { logger: fake, infoCalls } = fakeLogger();
      const logger = new MCPLogger(false, undefined, fake);
      const cost: CostInfo = {
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        estimatedCost: 0.001,
      };

      await logger.logChatInteraction(
        "test_tool",
        "conv_123",
        [{ role: "user", content: "test" }],
        [],
        "response",
        1000,
        cost,
      );

      expect(infoCalls).toHaveLength(0);
    });

    it("should call custom callback when provided", async () => {
      const callback = mock<MCPLogCallback>(() => Promise.resolve());
      const logger = new MCPLogger(false, callback);
      const cost: CostInfo = {
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        estimatedCost: 0.001,
      };

      await logger.logChatInteraction(
        "test_tool",
        "conv_123",
        [{ role: "user", content: "test" }],
        [],
        "response",
        1000,
        cost,
      );

      expect(callback).toHaveBeenCalled();
      const event = callback.mock.calls[0][0];
      expect(event.toolName).toBe("test_tool");
      expect(event.conversationId).toBe("conv_123");
      expect(event.cost).toEqual(cost);
    });

    it("should include all event data", async () => {
      const callback = mock<MCPLogCallback>(() => Promise.resolve());
      const logger = new MCPLogger(false, callback);
      const cost: CostInfo = {
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        estimatedCost: 0.001,
      };
      const messages = [
        { role: "user" as const, content: "question" },
        { role: "assistant" as const, content: "answer" },
      ];
      const ragContext = ["context1", "context2"];

      await logger.logChatInteraction(
        "test_tool",
        "conv_123",
        messages,
        ragContext,
        "final response",
        1500,
        cost,
      );

      const event = callback.mock.calls[0][0];
      expect(event.timestamp).toBeDefined();
      expect(event.userMessage).toBe("question");
      expect(event.conversationHistory).toEqual(messages);
      expect(event.ragContext).toEqual(ragContext);
      expect(event.response).toBe("final response");
      expect(event.duration).toBe(1500);
    });

    it("should extract last user message correctly", async () => {
      const callback = mock<MCPLogCallback>(() => Promise.resolve());
      const logger = new MCPLogger(false, callback);
      const cost: CostInfo = {
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        estimatedCost: 0.001,
      };
      const messages = [
        { role: "user" as const, content: "first" },
        { role: "assistant" as const, content: "reply1" },
        { role: "user" as const, content: "second" },
        { role: "assistant" as const, content: "reply2" },
      ];

      await logger.logChatInteraction(
        "test_tool",
        "conv_123",
        messages,
        [],
        "response",
        1000,
        cost,
      );

      const event = callback.mock.calls[0][0];
      expect(event.userMessage).toBe("second");
    });

    it("should handle errors in callback gracefully", async () => {
      const { logger: fake, errorCalls } = fakeLogger();
      const callback = mock<MCPLogCallback>(() => {
        throw new Error("Callback error");
      });
      const logger = new MCPLogger(false, callback, fake);
      const cost: CostInfo = {
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        estimatedCost: 0.001,
      };

      // Should not throw even if callback throws
      await logger.logChatInteraction(
        "test_tool",
        "conv_123",
        [{ role: "user", content: "test" }],
        [],
        "response",
        1000,
        cost,
      );

      expect(errorCalls).toHaveLength(1);
    });

    it("should handle async callback errors", async () => {
      const { logger: fake, errorCalls } = fakeLogger();
      const callback = mock<MCPLogCallback>(() => Promise.reject(new Error("Async error")));
      const logger = new MCPLogger(false, callback, fake);
      const cost: CostInfo = {
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        estimatedCost: 0.001,
      };

      await logger.logChatInteraction(
        "test_tool",
        "conv_123",
        [{ role: "user", content: "test" }],
        [],
        "response",
        1000,
        cost,
      );

      // Give async error handling time to complete
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(errorCalls).toHaveLength(1);
    });
  });
});

describe("createLogger", () => {
  it("should create logger with default console logging enabled", () => {
    const logger = createLogger();
    expect(logger).toBeInstanceOf(MCPLogger);
  });

  it("should create logger with console logging disabled", () => {
    const logger = createLogger(false);
    expect(logger).toBeInstanceOf(MCPLogger);
  });

  it("should create logger with custom callback", () => {
    const callback = mock<MCPLogCallback>(() => Promise.resolve());
    const logger = createLogger(true, callback);
    expect(logger).toBeInstanceOf(MCPLogger);
  });
});
