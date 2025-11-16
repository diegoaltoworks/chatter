import type { Context, Next } from "hono";
import {
  type JWTVerifyOptions,
  type KeyLike,
  createRemoteJWKSet,
  importSPKI,
  jwtVerify,
} from "jose";
import type { ChatterConfig } from "../types";

// Extend Context type to include jwtSub
interface ContextWithJWT extends Context {
  jwtSub?: string;
}

/**
 * Create JWT authentication middleware for private API endpoints
 * Supports JWKS and public key PEM verification
 */
export function createJWTMiddleware(config: ChatterConfig) {
  let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
  let spkiKey: KeyLike | CryptoKey | null = null;

  const jwtConfig = config.auth?.jwt;

  async function verify(token: string) {
    const opts: JWTVerifyOptions = {};
    if (jwtConfig?.issuer) opts.issuer = jwtConfig.issuer;
    if (jwtConfig?.audience) opts.audience = jwtConfig.audience;

    if (jwtConfig?.jwksUrl) {
      jwks = jwks ?? createRemoteJWKSet(new URL(jwtConfig.jwksUrl));
      const { payload } = await jwtVerify(token, jwks, opts);
      return payload;
    }
    if (jwtConfig?.publicKeyPem) {
      spkiKey = spkiKey ?? (await importSPKI(jwtConfig.publicKeyPem, "RS256"));
      const { payload } = await jwtVerify(token, spkiKey, opts);
      return payload;
    }
    throw new Error("JWT configuration missing (JWKS URL or PUBLIC KEY PEM).");
  }

  return async function requirePrivateJWT(c: Context, next: Next) {
    const hdr = c.req.header("authorization") ?? "";
    if (!hdr.startsWith("Bearer ")) return c.json({ error: "Unauthorized" }, 401);
    const token = hdr.slice("Bearer ".length);
    try {
      const payload = await verify(token);
      // attach subject to context for rate limiting
      (c as ContextWithJWT).jwtSub = String(payload.sub ?? "");
      await next();
    } catch {
      return c.json({ error: "Unauthorized" }, 401);
    }
  };
}

// Backward compatibility export (will be removed when routes are updated)
export const requirePrivateJWT = createJWTMiddleware({} as ChatterConfig);
