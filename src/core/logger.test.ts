/**
 * The invariant under test: the default console logger never writes to
 * stdout, at any level — that's what keeps the stdio MCP transport's
 * JSON-RPC stream uncorrupted (see the module docstring).
 */

import { describe, expect, spyOn, test } from "bun:test";
import { createConsoleLogger, resolveLogger } from "./logger";

describe("createConsoleLogger", () => {
  test("never writes to stdout at any level", () => {
    const stdout = spyOn(console, "log").mockImplementation(() => {});
    const infoSpy = spyOn(console, "info").mockImplementation(() => {});
    const debugSpy = spyOn(console, "debug").mockImplementation(() => {});
    try {
      const logger = createConsoleLogger("debug");
      logger.debug("d");
      logger.info("i");
      logger.warn("w");
      logger.error("e");

      expect(stdout).not.toHaveBeenCalled();
      expect(infoSpy).not.toHaveBeenCalled();
      expect(debugSpy).not.toHaveBeenCalled();
    } finally {
      stdout.mockRestore();
      infoSpy.mockRestore();
      debugSpy.mockRestore();
    }
  });

  test("every level writes via console.error (stderr)", () => {
    const stderr = spyOn(console, "error").mockImplementation(() => {});
    try {
      const logger = createConsoleLogger("debug");
      logger.debug("d");
      logger.info("i");
      logger.warn("w");
      logger.error("e");

      expect(stderr).toHaveBeenCalledTimes(4);
    } finally {
      stderr.mockRestore();
    }
  });

  test("default level is info: debug is suppressed, info/warn/error are not", () => {
    const stderr = spyOn(console, "error").mockImplementation(() => {});
    try {
      const logger = createConsoleLogger();
      logger.debug("suppressed");
      expect(stderr).not.toHaveBeenCalled();

      logger.info("shown");
      expect(stderr).toHaveBeenCalledTimes(1);
    } finally {
      stderr.mockRestore();
    }
  });

  test("a stricter level suppresses everything below it", () => {
    const stderr = spyOn(console, "error").mockImplementation(() => {});
    try {
      const logger = createConsoleLogger("error");
      logger.debug("x");
      logger.info("x");
      logger.warn("x");
      expect(stderr).not.toHaveBeenCalled();

      logger.error("shown");
      expect(stderr).toHaveBeenCalledTimes(1);
    } finally {
      stderr.mockRestore();
    }
  });
});

describe("resolveLogger", () => {
  test("returns the given logger unchanged, ignoring level", () => {
    const calls: string[] = [];
    const custom = {
      debug: () => calls.push("debug"),
      info: () => calls.push("info"),
      warn: () => calls.push("warn"),
      error: () => calls.push("error"),
    };

    const resolved = resolveLogger(custom, "error");
    resolved.debug("still fires — custom logger, not level-gated by resolveLogger");

    expect(resolved).toBe(custom);
    expect(calls).toEqual(["debug"]);
  });

  test("falls back to a console logger at the given level when no logger is supplied", () => {
    const stderr = spyOn(console, "error").mockImplementation(() => {});
    try {
      const resolved = resolveLogger(undefined, "warn");
      resolved.info("suppressed at warn");
      expect(stderr).not.toHaveBeenCalled();

      resolved.warn("shown");
      expect(stderr).toHaveBeenCalledTimes(1);
    } finally {
      stderr.mockRestore();
    }
  });
});
