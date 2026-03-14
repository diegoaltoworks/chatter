import { beforeEach, describe, expect, it } from "bun:test";
import { ApiKeyManager } from "./apikeys";

describe("ApiKeyManager", () => {
  let manager: ApiKeyManager;
  const testSecret = "test-secret-key-for-jwt-signing-12345678";

  beforeEach(() => {
    manager = new ApiKeyManager(testSecret);
  });

  describe("constructor", () => {
    it("should throw error if secret is not provided", () => {
      expect(() => new ApiKeyManager("")).toThrow("API key secret is required");
    });

    it("should create instance with valid secret", () => {
      expect(manager).toBeDefined();
    });
  });

  describe("create", () => {
    it("should create an API key with default options", async () => {
      const key = await manager.create();

      expect(key).toBeDefined();
      expect(typeof key).toBe("string");
      expect(key.split(".")).toHaveLength(3); // JWT format
    });

    it("should create an API key with custom name", async () => {
      const key = await manager.create({ name: "test-app" });
      const decoded = manager.decode(key);

      expect(decoded).toBeDefined();
      expect(decoded?.name).toBe("test-app");
    });

    it("should create an API key with custom expiration", async () => {
      const key = await manager.create({ expiresIn: "1h" });
      const decoded = manager.decode(key);

      expect(decoded).toBeDefined();
      expect(decoded?.exp).toBeGreaterThan(Date.now() / 1000);
      expect(decoded?.exp).toBeLessThan(Date.now() / 1000 + 3700); // ~1 hour
    });

    it("should include custom claims in the API key", async () => {
      const key = await manager.create({
        name: "custom-app",
        claims: {
          environment: "production",
          tier: "premium",
        },
      });

      const decoded = manager.decode(key);
      expect(decoded?.environment).toBe("production");
      expect(decoded?.tier).toBe("premium");
    });

    it("should always include type=api_key", async () => {
      const key = await manager.create();
      const decoded = manager.decode(key);

      expect(decoded?.type).toBe("api_key");
    });

    it("should generate unique keys", async () => {
      const key1 = await manager.create();
      const key2 = await manager.create();

      expect(key1).not.toBe(key2);

      const decoded1 = manager.decode(key1);
      const decoded2 = manager.decode(key2);

      expect(decoded1?.sub).not.toBe(decoded2?.sub);
    });
  });

  describe("verify", () => {
    it("should verify a valid API key", async () => {
      const key = await manager.create({ name: "test-key" });
      const result = await manager.verify(key);

      expect(result.valid).toBe(true);
      expect(result.payload).toBeDefined();
      expect(result.payload?.name).toBe("test-key");
      expect(result.payload?.type).toBe("api_key");
      expect(result.error).toBeUndefined();
    });

    it("should reject invalid JWT format", async () => {
      const result = await manager.verify("not-a-valid-jwt");

      expect(result.valid).toBe(false);
      expect(result.payload).toBeUndefined();
      expect(result.error).toBeDefined();
    });

    it("should reject JWT with wrong signature", async () => {
      const otherManager = new ApiKeyManager("different-secret");
      const key = await otherManager.create();
      const result = await manager.verify(key);

      expect(result.valid).toBe(false);
      expect(result.error).toContain("signature");
    });

    it("should reject expired API key", async () => {
      // Create a key that expires immediately
      const key = await manager.create({ expiresIn: "1s" });

      // Wait for expiration
      await new Promise((resolve) => setTimeout(resolve, 1100));

      const result = await manager.verify(key);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("exp");
    });

    it("should reject token that is not an API key type", async () => {
      // Create a JWT manually without type=api_key
      const { SignJWT } = await import("jose");
      const secret = new TextEncoder().encode(testSecret);
      const token = await new SignJWT({ type: "other_type" })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject("test-sub")
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(secret);

      const result = await manager.verify(token);
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Token is not an API key");
    });
  });

  describe("decode", () => {
    it("should decode a valid JWT without verification", async () => {
      const key = await manager.create({ name: "decode-test" });
      const decoded = manager.decode(key);

      expect(decoded).toBeDefined();
      expect(decoded?.name).toBe("decode-test");
      expect(decoded?.type).toBe("api_key");
      expect(decoded?.sub).toBeDefined();
    });

    it("should return null for invalid JWT format", () => {
      const decoded = manager.decode("not-a-jwt");
      expect(decoded).toBeNull();
    });

    it("should return null for malformed JWT", () => {
      const decoded = manager.decode("header.payload");
      expect(decoded).toBeNull();
    });

    it("should decode without verifying signature", async () => {
      // Create key with different manager
      const otherManager = new ApiKeyManager("other-secret");
      const key = await otherManager.create({ name: "other-key" });

      // Should decode successfully even though signature doesn't match
      const decoded = manager.decode(key);
      expect(decoded).toBeDefined();
      expect(decoded?.name).toBe("other-key");
    });
  });

  describe("parseExpiration", () => {
    it("should parse seconds", async () => {
      const key = await manager.create({ expiresIn: "30s" });
      const decoded = manager.decode(key);

      expect(decoded).toBeDefined();
      const expiresIn = (decoded?.exp ?? 0) - (decoded?.iat ?? 0);
      expect(expiresIn).toBeCloseTo(30, 0);
    });

    it("should parse minutes", async () => {
      const key = await manager.create({ expiresIn: "15m" });
      const decoded = manager.decode(key);

      const expiresIn = (decoded?.exp ?? 0) - (decoded?.iat ?? 0);
      expect(expiresIn).toBeCloseTo(15 * 60, 0);
    });

    it("should parse hours", async () => {
      const key = await manager.create({ expiresIn: "2h" });
      const decoded = manager.decode(key);

      const expiresIn = (decoded?.exp ?? 0) - (decoded?.iat ?? 0);
      expect(expiresIn).toBeCloseTo(2 * 60 * 60, 0);
    });

    it("should parse days", async () => {
      const key = await manager.create({ expiresIn: "7d" });
      const decoded = manager.decode(key);

      const expiresIn = (decoded?.exp ?? 0) - (decoded?.iat ?? 0);
      expect(expiresIn).toBeCloseTo(7 * 24 * 60 * 60, 0);
    });

    it("should parse months", async () => {
      const key = await manager.create({ expiresIn: "2M" });
      const decoded = manager.decode(key);

      const expiresIn = (decoded?.exp ?? 0) - (decoded?.iat ?? 0);
      // Approximate 30 days per month
      expect(expiresIn).toBeCloseTo(2 * 30 * 24 * 60 * 60, 0);
    });

    it("should parse years", async () => {
      const key = await manager.create({ expiresIn: "1y" });
      const decoded = manager.decode(key);

      const expiresIn = (decoded?.exp ?? 0) - (decoded?.iat ?? 0);
      expect(expiresIn).toBeCloseTo(365 * 24 * 60 * 60, 0);
    });

    it("should throw error for invalid format", async () => {
      await expect(manager.create({ expiresIn: "invalid" })).rejects.toThrow(
        "Invalid expiration format",
      );
    });

    it("should throw error for unknown unit", async () => {
      await expect(manager.create({ expiresIn: "10x" })).rejects.toThrow(
        "Invalid expiration format",
      );
    });
  });
});
