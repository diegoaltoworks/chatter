import { beforeEach, describe, expect, it } from "bun:test";
import { createSession, getActiveSessions, getSessionInfo, validateSession } from "./session";

describe("Session Management", () => {
  describe("createSession", () => {
    it("should create a session with default values", () => {
      const session = createSession();

      expect(session.key).toStartWith("session_");
      expect(session.requests).toBe(0);
      expect(session.maxRequests).toBe(20);
      expect(session.created).toBeGreaterThan(0);
      expect(session.expiresAt).toBeGreaterThan(session.created);
    });

    it("should create a session with custom maxRequests", () => {
      const session = createSession({ maxRequests: 50 });

      expect(session.maxRequests).toBe(50);
      expect(session.requests).toBe(0);
    });

    it("should create a session with custom TTL", () => {
      const session = createSession({ ttl: 1800 }); // 30 minutes
      const expectedExpiry = session.created + 1800 * 1000;

      expect(session.expiresAt).toBeCloseTo(expectedExpiry, -2); // Within 100ms
    });

    it("should generate unique keys for each session", () => {
      const session1 = createSession();
      const session2 = createSession();

      expect(session1.key).not.toBe(session2.key);
    });

    it("should store metadata when provided", () => {
      const metadata = {
        userId: "user-123",
        email: "test@example.com",
        authenticated: true,
      };
      const session = createSession({ metadata });

      expect(session.metadata).toEqual(metadata);

      // Verify metadata is persisted
      const info = getSessionInfo(session.key);
      expect(info?.metadata).toEqual(metadata);
    });

    it("should not include metadata when not provided", () => {
      const session = createSession();
      expect(session.metadata).toBeUndefined();
    });

    it("should use default TTL of 1 hour", () => {
      const session = createSession();
      const expectedExpiry = session.created + 3600 * 1000; // 1 hour

      expect(session.expiresAt).toBeCloseTo(expectedExpiry, -2);
    });
  });

  describe("validateSession", () => {
    it("should validate a newly created session", () => {
      const session = createSession();
      const isValid = validateSession(session.key);

      expect(isValid).toBe(true);
    });

    it("should increment request count on validation", () => {
      const session = createSession();

      validateSession(session.key);
      const info = getSessionInfo(session.key);

      expect(info?.requests).toBe(1);

      validateSession(session.key);
      const info2 = getSessionInfo(session.key);

      expect(info2?.requests).toBe(2);
    });

    it("should reject invalid session key", () => {
      const isValid = validateSession("invalid_key");

      expect(isValid).toBe(false);
    });

    it("should reject session when quota is exceeded", () => {
      const session = createSession({ maxRequests: 3 });

      // Use up the quota
      expect(validateSession(session.key)).toBe(true); // 1
      expect(validateSession(session.key)).toBe(true); // 2
      expect(validateSession(session.key)).toBe(true); // 3

      // Should be rejected now
      expect(validateSession(session.key)).toBe(false);
    });

    it("should reject expired session", () => {
      const session = createSession({ ttl: -1 }); // Expired immediately

      const isValid = validateSession(session.key);

      expect(isValid).toBe(false);
    });

    it("should clean up expired session", () => {
      const session = createSession({ ttl: -1 }); // Expired

      // Trigger cleanup by validating
      validateSession(session.key);

      const info = getSessionInfo(session.key);
      expect(info).toBeNull();
    });

    it("should handle multiple sessions independently", () => {
      const session1 = createSession({ maxRequests: 2 });
      const session2 = createSession({ maxRequests: 2 });

      // Use session1
      expect(validateSession(session1.key)).toBe(true);
      expect(validateSession(session1.key)).toBe(true);
      expect(validateSession(session1.key)).toBe(false); // Quota exceeded

      // Session2 should still work
      expect(validateSession(session2.key)).toBe(true);
      expect(validateSession(session2.key)).toBe(true);
    });
  });

  describe("getSessionInfo", () => {
    it("should return session data for valid key", () => {
      const session = createSession({ maxRequests: 25 });
      const info = getSessionInfo(session.key);

      expect(info).not.toBeNull();
      expect(info?.key).toBe(session.key);
      expect(info?.maxRequests).toBe(25);
      expect(info?.requests).toBe(0);
    });

    it("should return null for invalid key", () => {
      const info = getSessionInfo("non_existent_key");

      expect(info).toBeNull();
    });

    it("should reflect updated request count", () => {
      const session = createSession();

      validateSession(session.key);
      validateSession(session.key);

      const info = getSessionInfo(session.key);
      expect(info?.requests).toBe(2);
    });

    it("should return metadata if set", () => {
      const metadata = { userId: "test-123" };
      const session = createSession({ metadata });

      const info = getSessionInfo(session.key);
      expect(info?.metadata).toEqual(metadata);
    });
  });

  describe("getActiveSessions", () => {
    beforeEach(() => {
      // Note: sessions persist in memory across tests
      // This is a limitation of the in-memory implementation
    });

    it("should return count of active sessions", () => {
      const initialCount = getActiveSessions();

      createSession();
      createSession();
      createSession();

      const newCount = getActiveSessions();
      expect(newCount).toBe(initialCount + 3);
    });

    it("should not count expired sessions after cleanup", () => {
      const session = createSession({ ttl: -1 }); // Expired

      // Trigger cleanup by validating (which deletes expired)
      validateSession(session.key);

      const info = getSessionInfo(session.key);
      expect(info).toBeNull();
    });

    it("should count sessions with different TTLs", () => {
      const initialCount = getActiveSessions();

      createSession({ ttl: 60 }); // 1 minute
      createSession({ ttl: 3600 }); // 1 hour
      createSession({ ttl: 86400 }); // 1 day

      const newCount = getActiveSessions();
      expect(newCount).toBe(initialCount + 3);
    });
  });

  describe("Session lifecycle", () => {
    it("should allow full quota of requests", () => {
      const maxRequests = 5;
      const session = createSession({ maxRequests });

      for (let i = 0; i < maxRequests; i++) {
        expect(validateSession(session.key)).toBe(true);
      }

      // Next request should fail
      expect(validateSession(session.key)).toBe(false);
    });

    it("should track requests accurately", () => {
      const session = createSession({ maxRequests: 10 });

      // Use 7 requests
      for (let i = 0; i < 7; i++) {
        validateSession(session.key);
      }

      const info = getSessionInfo(session.key);
      expect(info?.requests).toBe(7);
      expect(info?.maxRequests).toBe(10);
    });

    it("should handle session expiry gracefully", async () => {
      const session = createSession({ ttl: 1 }); // 1 second

      // Initial validation should work
      expect(validateSession(session.key)).toBe(true);

      // Wait for expiration
      await new Promise((resolve) => setTimeout(resolve, 1100));

      // Should be rejected after expiry
      expect(validateSession(session.key)).toBe(false);
    });

    it("should preserve metadata through request lifecycle", () => {
      const metadata = { plan: "premium", userId: "user-456" };
      const session = createSession({ metadata, maxRequests: 5 });

      // Make several requests
      validateSession(session.key);
      validateSession(session.key);

      // Metadata should still be present
      const info = getSessionInfo(session.key);
      expect(info?.metadata).toEqual(metadata);
      expect(info?.requests).toBe(2);
    });
  });

  describe("Edge cases", () => {
    it("should handle very short TTL", async () => {
      const session = createSession({ ttl: 0 });

      // Wait a tiny bit to ensure expiration
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Should be expired
      expect(validateSession(session.key)).toBe(false);
    });

    it("should handle very long TTL", () => {
      const session = createSession({ ttl: 86400 * 365 }); // 1 year

      const expectedExpiry = session.created + 86400 * 365 * 1000;
      expect(session.expiresAt).toBeCloseTo(expectedExpiry, -2);
    });

    it("should handle zero maxRequests", () => {
      const session = createSession({ maxRequests: 0 });

      // Should immediately fail validation
      expect(validateSession(session.key)).toBe(false);
    });

    it("should handle single request quota", () => {
      const session = createSession({ maxRequests: 1 });

      expect(validateSession(session.key)).toBe(true);
      expect(validateSession(session.key)).toBe(false);
    });

    it("should handle empty metadata", () => {
      const session = createSession({ metadata: {} });

      expect(session.metadata).toEqual({});
    });
  });
});
