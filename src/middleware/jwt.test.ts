import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { SignJWT, generateKeyPair, exportSPKI } from "jose";
import type { ChatterConfig } from "../types";
import { createJWTMiddleware } from "./jwt";

describe("JWT Middleware", () => {
  describe("createJWTMiddleware", () => {
    it("should create middleware function", () => {
      const config: ChatterConfig = {
        auth: {
          jwt: {
            publicKeyPem: "test-pem",
          },
        },
      };

      const middleware = createJWTMiddleware(config);

      expect(middleware).toBeDefined();
      expect(typeof middleware).toBe("function");
    });

    it("should reject request without authorization header", async () => {
      const config: ChatterConfig = {
        auth: {
          jwt: {
            publicKeyPem: "test-pem",
          },
        },
      };

      const app = new Hono();
      app.use("/private/*", createJWTMiddleware(config));
      app.get("/private/test", (c) => c.json({ ok: true }));

      const req = new Request("http://localhost/private/test", {
        method: "GET",
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(401);

      const json = await res.json();
      expect(json.error).toBe("Unauthorized");
    });

    it("should reject request with invalid bearer format", async () => {
      const config: ChatterConfig = {
        auth: {
          jwt: {
            publicKeyPem: "test-pem",
          },
        },
      };

      const app = new Hono();
      app.use("/private/*", createJWTMiddleware(config));
      app.get("/private/test", (c) => c.json({ ok: true }));

      const req = new Request("http://localhost/private/test", {
        method: "GET",
        headers: {
          authorization: "Basic invalid",
        },
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(401);
    });

    it("should reject request with invalid JWT token", async () => {
      const config: ChatterConfig = {
        auth: {
          jwt: {
            publicKeyPem: "test-pem",
          },
        },
      };

      const app = new Hono();
      app.use("/private/*", createJWTMiddleware(config));
      app.get("/private/test", (c) => c.json({ ok: true }));

      const req = new Request("http://localhost/private/test", {
        method: "GET",
        headers: {
          authorization: "Bearer invalid.jwt.token",
        },
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(401);
    });

    it("should accept valid JWT with PEM public key", async () => {
      // Generate RSA key pair
      const { publicKey, privateKey } = await generateKeyPair("RS256");
      const publicKeyPem = await exportSPKI(publicKey);

      // Create config with public key
      const config: ChatterConfig = {
        auth: {
          jwt: {
            publicKeyPem,
          },
        },
      };

      // Create valid JWT
      const token = await new SignJWT({ sub: "user123" })
        .setProtectedHeader({ alg: "RS256" })
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(privateKey);

      const app = new Hono();
      app.use("/private/*", createJWTMiddleware(config));
      app.get("/private/test", (c) => c.json({ ok: true }));

      const req = new Request("http://localhost/private/test", {
        method: "GET",
        headers: {
          authorization: `Bearer ${token}`,
        },
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(200);
    });

    it("should attach jwtSub to context", async () => {
      // Generate RSA key pair
      const { publicKey, privateKey } = await generateKeyPair("RS256");
      const publicKeyPem = await exportSPKI(publicKey);

      const config: ChatterConfig = {
        auth: {
          jwt: {
            publicKeyPem,
          },
        },
      };

      // Create valid JWT with subject
      const token = await new SignJWT({ sub: "user-456" })
        .setProtectedHeader({ alg: "RS256" })
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(privateKey);

      let capturedSub: string | undefined;

      const app = new Hono();
      app.use("/private/*", createJWTMiddleware(config));
      app.get("/private/test", (c) => {
        capturedSub = (c as any).jwtSub;
        return c.json({ ok: true });
      });

      const req = new Request("http://localhost/private/test", {
        method: "GET",
        headers: {
          authorization: `Bearer ${token}`,
        },
      });

      await app.fetch(req);
      expect(capturedSub).toBe("user-456");
    });

    it("should validate issuer when configured", async () => {
      const { publicKey, privateKey } = await generateKeyPair("RS256");
      const publicKeyPem = await exportSPKI(publicKey);

      const config: ChatterConfig = {
        auth: {
          jwt: {
            publicKeyPem,
            issuer: "https://auth.example.com",
          },
        },
      };

      // Create JWT without issuer
      const invalidToken = await new SignJWT({ sub: "user123" })
        .setProtectedHeader({ alg: "RS256" })
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(privateKey);

      // Create JWT with correct issuer
      const validToken = await new SignJWT({ sub: "user123" })
        .setProtectedHeader({ alg: "RS256" })
        .setIssuer("https://auth.example.com")
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(privateKey);

      const app = new Hono();
      app.use("/private/*", createJWTMiddleware(config));
      app.get("/private/test", (c) => c.json({ ok: true }));

      // Test invalid issuer
      const invalidReq = new Request("http://localhost/private/test", {
        method: "GET",
        headers: {
          authorization: `Bearer ${invalidToken}`,
        },
      });

      const invalidRes = await app.fetch(invalidReq);
      expect(invalidRes.status).toBe(401);

      // Test valid issuer
      const validReq = new Request("http://localhost/private/test", {
        method: "GET",
        headers: {
          authorization: `Bearer ${validToken}`,
        },
      });

      const validRes = await app.fetch(validReq);
      expect(validRes.status).toBe(200);
    });

    it("should validate audience when configured", async () => {
      const { publicKey, privateKey } = await generateKeyPair("RS256");
      const publicKeyPem = await exportSPKI(publicKey);

      const config: ChatterConfig = {
        auth: {
          jwt: {
            publicKeyPem,
            audience: "api.example.com",
          },
        },
      };

      // Create JWT without audience
      const invalidToken = await new SignJWT({ sub: "user123" })
        .setProtectedHeader({ alg: "RS256" })
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(privateKey);

      // Create JWT with correct audience
      const validToken = await new SignJWT({ sub: "user123" })
        .setProtectedHeader({ alg: "RS256" })
        .setAudience("api.example.com")
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(privateKey);

      const app = new Hono();
      app.use("/private/*", createJWTMiddleware(config));
      app.get("/private/test", (c) => c.json({ ok: true }));

      // Test invalid audience
      const invalidReq = new Request("http://localhost/private/test", {
        method: "GET",
        headers: {
          authorization: `Bearer ${invalidToken}`,
        },
      });

      const invalidRes = await app.fetch(invalidReq);
      expect(invalidRes.status).toBe(401);

      // Test valid audience
      const validReq = new Request("http://localhost/private/test", {
        method: "GET",
        headers: {
          authorization: `Bearer ${validToken}`,
        },
      });

      const validRes = await app.fetch(validReq);
      expect(validRes.status).toBe(200);
    });

    it("should reject expired JWT", async () => {
      const { publicKey, privateKey } = await generateKeyPair("RS256");
      const publicKeyPem = await exportSPKI(publicKey);

      const config: ChatterConfig = {
        auth: {
          jwt: {
            publicKeyPem,
          },
        },
      };

      // Create expired JWT (expired 1 second ago)
      const expiredToken = await new SignJWT({ sub: "user123" })
        .setProtectedHeader({ alg: "RS256" })
        .setIssuedAt()
        .setExpirationTime(Math.floor(Date.now() / 1000) - 1)
        .sign(privateKey);

      const app = new Hono();
      app.use("/private/*", createJWTMiddleware(config));
      app.get("/private/test", (c) => c.json({ ok: true }));

      const req = new Request("http://localhost/private/test", {
        method: "GET",
        headers: {
          authorization: `Bearer ${expiredToken}`,
        },
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(401);
    });

    it("should reject JWT with wrong signature", async () => {
      // Generate two different key pairs
      const { publicKey: publicKey1 } = await generateKeyPair("RS256");
      const { privateKey: privateKey2 } = await generateKeyPair("RS256");

      const publicKeyPem = await exportSPKI(publicKey1);

      const config: ChatterConfig = {
        auth: {
          jwt: {
            publicKeyPem,
          },
        },
      };

      // Sign JWT with different private key
      const token = await new SignJWT({ sub: "user123" })
        .setProtectedHeader({ alg: "RS256" })
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(privateKey2);

      const app = new Hono();
      app.use("/private/*", createJWTMiddleware(config));
      app.get("/private/test", (c) => c.json({ ok: true }));

      const req = new Request("http://localhost/private/test", {
        method: "GET",
        headers: {
          authorization: `Bearer ${token}`,
        },
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(401);
    });

    it("should throw error when no JWT config provided", async () => {
      const config: ChatterConfig = {
        auth: {
          jwt: {},
        },
      };

      const app = new Hono();
      app.use("/private/*", createJWTMiddleware(config));
      app.get("/private/test", (c) => c.json({ ok: true }));

      const req = new Request("http://localhost/private/test", {
        method: "GET",
        headers: {
          authorization: "Bearer fake.jwt.token",
        },
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(401);
    });

    it("should work with middleware chain", async () => {
      const { publicKey, privateKey } = await generateKeyPair("RS256");
      const publicKeyPem = await exportSPKI(publicKey);

      const config: ChatterConfig = {
        auth: {
          jwt: {
            publicKeyPem,
          },
        },
      };

      const token = await new SignJWT({ sub: "user123" })
        .setProtectedHeader({ alg: "RS256" })
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(privateKey);

      const app = new Hono();

      // Add custom middleware before JWT
      app.use("/private/*", async (c, next) => {
        c.header("X-Custom", "value");
        await next();
      });

      app.use("/private/*", createJWTMiddleware(config));
      app.get("/private/test", (c) => c.json({ ok: true }));

      const req = new Request("http://localhost/private/test", {
        method: "GET",
        headers: {
          authorization: `Bearer ${token}`,
        },
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(200);
      expect(res.headers.get("X-Custom")).toBe("value");
    });

    it("should stop middleware chain on JWT failure", async () => {
      const config: ChatterConfig = {
        auth: {
          jwt: {
            publicKeyPem: "test-pem",
          },
        },
      };

      let nextCalled = false;

      const app = new Hono();
      app.use("/private/*", createJWTMiddleware(config));
      app.use("/private/*", async (c, next) => {
        nextCalled = true;
        await next();
      });
      app.get("/private/test", (c) => c.json({ ok: true }));

      const req = new Request("http://localhost/private/test", {
        method: "GET",
        headers: {
          authorization: "Bearer invalid.jwt.token",
        },
      });

      await app.fetch(req);
      expect(nextCalled).toBe(false);
    });

    it("should handle JWT with no subject claim", async () => {
      const { publicKey, privateKey } = await generateKeyPair("RS256");
      const publicKeyPem = await exportSPKI(publicKey);

      const config: ChatterConfig = {
        auth: {
          jwt: {
            publicKeyPem,
          },
        },
      };

      // Create JWT without sub claim
      const token = await new SignJWT({})
        .setProtectedHeader({ alg: "RS256" })
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(privateKey);

      let capturedSub: string | undefined;

      const app = new Hono();
      app.use("/private/*", createJWTMiddleware(config));
      app.get("/private/test", (c) => {
        capturedSub = (c as any).jwtSub;
        return c.json({ ok: true });
      });

      const req = new Request("http://localhost/private/test", {
        method: "GET",
        headers: {
          authorization: `Bearer ${token}`,
        },
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(200);
      expect(capturedSub).toBe("");
    });
  });
});
