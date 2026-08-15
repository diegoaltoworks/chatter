import { describe, expect, test } from "bun:test";
import { assertStrongSecret } from "./secretStrength";

describe("assertStrongSecret", () => {
  test("accepts a secret at least 16 characters long", () => {
    expect(() => assertStrongSecret("sixteen-characts", "TEST_SECRET")).not.toThrow();
  });

  test("throws an actionable error for an empty secret", () => {
    expect(() => assertStrongSecret("", "TEST_SECRET")).toThrow(
      "TEST_SECRET is required and cannot be empty.",
    );
  });

  test("throws an actionable error for an undefined secret", () => {
    expect(() => assertStrongSecret(undefined, "TEST_SECRET")).toThrow(
      "TEST_SECRET is required and cannot be empty.",
    );
  });

  test("throws an actionable error for a too-short secret", () => {
    expect(() => assertStrongSecret("short", "TEST_SECRET")).toThrow(
      "TEST_SECRET is too weak: must be at least 16 characters (got 5).",
    );
  });
});
