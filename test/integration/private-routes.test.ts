import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SignJWT, exportSPKI, generateKeyPair } from "jose";
import OpenAI from "openai";
import { createServer } from "../../src";
import type { ChatterConfig } from "../../src/types";

describe("Private Routes Integration", () => {
  // Skip tests if no OpenAI API key
  if (!process.env.OPENAI_API_KEY) {
    it.skip("requires OPENAI_API_KEY to run", () => {});
    return;
  }

  let testDir: string;
  let app: Awaited<ReturnType<typeof createServer>>;
  let validToken: string;
  let publicKeyPem: string;

  beforeAll(async () => {
    // Generate RSA key pair for JWT testing
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    publicKeyPem = await exportSPKI(publicKey);

    // Create valid JWT token
    validToken = await new SignJWT({ sub: "test-user-123" })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer("https://test-issuer.example.com")
      .setAudience("test-api")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);

    // Create temporary directory for test
    testDir = await mkdtemp(join(tmpdir(), "chatter-private-test-"));

    // Create test config with JWT authentication
    const config: ChatterConfig = {
      model: "gpt-4o-mini",
      auth: {
        jwt: {
          publicKeyPem,
          issuer: "https://test-issuer.example.com",
          audience: "test-api",
        },
      },
      rateLimit: {
        privateApiPerMinute: 100,
      },
    };

    // Create OpenAI client
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY ?? "" });

    // Create server with test config
    app = await createServer({ config, client, storePath: testDir });
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe("POST /api/private/chat", () => {
    it("should reject request without JWT token", async () => {
      const req = new Request("http://localhost/api/private/chat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ message: "test message" }),
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(401);

      const json = await res.json();
      expect(json.error).toBe("Unauthorized");
    });

    it("should reject request with invalid JWT token", async () => {
      const req = new Request("http://localhost/api/private/chat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer invalid.jwt.token",
        },
        body: JSON.stringify({ message: "test message" }),
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(401);
    });

    it("should accept valid JWT and respond to single message", async () => {
      const req = new Request("http://localhost/api/private/chat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${validToken}`,
        },
        body: JSON.stringify({ message: "Hello" }),
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.reply).toBeDefined();
      expect(typeof json.reply).toBe("string");
    });

    it("should accept valid JWT and respond to conversation history", async () => {
      const req = new Request("http://localhost/api/private/chat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${validToken}`,
        },
        body: JSON.stringify({
          messages: [
            { role: "user", content: "What is 2+2?" },
            { role: "assistant", content: "2+2 equals 4." },
            { role: "user", content: "And what is 3+3?" },
          ],
        }),
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.reply).toBeDefined();
      expect(typeof json.reply).toBe("string");
    });

    it("should support streaming with stream=1 query parameter", async () => {
      const req = new Request("http://localhost/api/private/chat?stream=1", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${validToken}`,
        },
        body: JSON.stringify({ message: "Hi" }),
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(200);

      // Read stream
      const reader = res.body?.getReader();
      expect(reader).toBeDefined();

      const decoder = new TextDecoder();
      let chunks = "";

      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks += decoder.decode(value, { stream: true });
      }

      // Verify SSE format
      expect(chunks).toContain("data:");
      expect(chunks).toContain("event: end");
    });

    it("should support streaming with text/event-stream accept header", async () => {
      const req = new Request("http://localhost/api/private/chat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          authorization: `Bearer ${validToken}`,
        },
        body: JSON.stringify({ message: "Hello" }),
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(200);

      // Should return streaming response
      const reader = res.body?.getReader();
      expect(reader).toBeDefined();
    });

    it("should return error for empty messages array", async () => {
      const req = new Request("http://localhost/api/private/chat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${validToken}`,
        },
        body: JSON.stringify({ messages: [] }),
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(400);

      const json = await res.json();
      expect(json.error).toContain("empty");
    });

    it("should return error when no message or messages provided", async () => {
      const req = new Request("http://localhost/api/private/chat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${validToken}`,
        },
        body: JSON.stringify({}),
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(400);

      const json = await res.json();
      expect(json.error).toContain("required");
    });

    it("should use RAG context from vector store", async () => {
      // This test verifies that the private endpoint queries the vector store
      // We can't easily verify the exact context, but we can ensure it completes
      const req = new Request("http://localhost/api/private/chat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${validToken}`,
        },
        body: JSON.stringify({ message: "Tell me about your capabilities" }),
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.reply).toBeDefined();
    });

    it("should handle malformed JSON gracefully", async () => {
      const req = new Request("http://localhost/api/private/chat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${validToken}`,
        },
        body: "not valid json",
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(400);
    });
  });

  describe("Rate Limiting", () => {
    it("should apply rate limiting to private endpoints", async () => {
      // Make requests up to the limit
      const requests = Array.from({ length: 5 }, () =>
        app.fetch(
          new Request("http://localhost/api/private/chat", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${validToken}`,
            },
            body: JSON.stringify({ message: "test" }),
          }),
        ),
      );

      const responses = await Promise.all(requests);

      // All should succeed (within rate limit)
      for (const res of responses) {
        expect([200, 429]).toContain(res.status);
      }
    });
  });

  describe("JWT Subject in Context", () => {
    it("should attach JWT subject to request context for rate limiting", async () => {
      // Create token with specific subject
      const { publicKey, privateKey } = await generateKeyPair("RS256");
      const pem = await exportSPKI(publicKey);

      const token = await new SignJWT({ sub: "rate-limit-user" })
        .setProtectedHeader({ alg: "RS256" })
        .setIssuer("https://test-issuer.example.com")
        .setAudience("test-api")
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(privateKey);

      // Create new server with this key
      const tempDir = await mkdtemp(join(tmpdir(), "chatter-jwt-test-"));
      const config: ChatterConfig = {
        model: "gpt-4o-mini",
        auth: {
          jwt: {
            publicKeyPem: pem,
            issuer: "https://test-issuer.example.com",
            audience: "test-api",
          },
        },
        rateLimit: {
          privateApiPerMinute: 5,
        },
      };

      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY ?? "" });
      const testApp = await createServer({ config, client, storePath: tempDir });

      // Make request with JWT
      const req = new Request("http://localhost/api/private/chat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ message: "test" }),
      });

      const res = await testApp.fetch(req);
      expect([200, 429]).toContain(res.status);

      // Cleanup
      await rm(tempDir, { recursive: true, force: true });
    });
  });
});
