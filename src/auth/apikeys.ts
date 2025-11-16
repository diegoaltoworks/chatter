/**
 * API Key Management
 *
 * Provides JWT-based API key creation and verification for Chatter.
 * This is the default implementation - developers can provide their own.
 */

import { randomUUID } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";

export interface ApiKeyOptions {
  /** Name/label for the API key */
  name?: string;
  /** Expiration time (e.g., "1y", "30d", "12h") */
  expiresIn?: string;
  /** Additional custom claims to include in the JWT */
  claims?: Record<string, unknown>;
}

export interface ApiKeyPayload {
  /** Key ID (subject) */
  sub: string;
  /** Key name/label */
  name: string;
  /** Token type - always "api_key" */
  type: "api_key";
  /** Issued at timestamp */
  iat: number;
  /** Expiration timestamp */
  exp: number;
  /** Additional custom claims */
  [key: string]: unknown;
}

export interface VerifyResult {
  /** Whether the token is valid */
  valid: boolean;
  /** Decoded payload if valid */
  payload?: ApiKeyPayload;
  /** Error message if invalid */
  error?: string;
}

/**
 * API Key Manager
 *
 * Manages creation and verification of JWT-based API keys.
 * Can be used both programmatically and via CLI.
 */
export class ApiKeyManager {
  private secretBytes: Uint8Array;

  constructor(private secret: string) {
    if (!secret) {
      throw new Error("API key secret is required");
    }
    this.secretBytes = new TextEncoder().encode(secret);
  }

  /**
   * Create a new API key
   *
   * @param options - API key options
   * @returns JWT token string
   */
  async create(options: ApiKeyOptions = {}): Promise<string> {
    const keyId = randomUUID();
    const keyName = options.name || "api-key";
    const expiresIn = options.expiresIn || "365d"; // Default 1 year

    // Parse expiration time
    const expirationMs = this.parseExpiration(expiresIn);
    const expiresAt = new Date(Date.now() + expirationMs);

    // Create JWT with payload
    const jwt = await new SignJWT({
      name: keyName,
      type: "api_key",
      ...options.claims,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(keyId)
      .setIssuedAt()
      .setExpirationTime(expiresAt)
      .sign(this.secretBytes);

    return jwt;
  }

  /**
   * Verify an API key
   *
   * @param token - JWT token to verify
   * @returns Verification result with payload if valid
   */
  async verify(token: string): Promise<VerifyResult> {
    try {
      const { payload } = await jwtVerify(token, this.secretBytes);

      // Verify it's an API key type token
      if (payload.type !== "api_key") {
        return {
          valid: false,
          error: "Token is not an API key",
        };
      }

      return {
        valid: true,
        payload: payload as ApiKeyPayload,
      };
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : "Verification failed",
      };
    }
  }

  /**
   * Parse expiration string to milliseconds
   *
   * @param expiresIn - Time string (e.g., "1y", "30d", "12h")
   * @returns Milliseconds
   */
  private parseExpiration(expiresIn: string): number {
    const match = expiresIn.match(/^(\d+)([smhdMy])$/);
    if (!match) {
      throw new Error(
        `Invalid expiration format: ${expiresIn}. Supported: s (seconds), m (minutes), h (hours), d (days), M (months), y (years)`,
      );
    }

    const value = Number.parseInt(match[1], 10);
    const unit = match[2];

    switch (unit) {
      case "s":
        return value * 1000;
      case "m":
        return value * 60 * 1000;
      case "h":
        return value * 60 * 60 * 1000;
      case "d":
        return value * 24 * 60 * 60 * 1000;
      case "M":
        return value * 30 * 24 * 60 * 60 * 1000; // Approximate 30 days
      case "y":
        return value * 365 * 24 * 60 * 60 * 1000; // Approximate 365 days
      default:
        throw new Error(`Unknown time unit: ${unit}`);
    }
  }

  /**
   * Get information about a token without verifying signature
   * Useful for debugging
   *
   * @param token - JWT token
   * @returns Decoded payload (unverified)
   */
  decode(token: string): ApiKeyPayload | null {
    try {
      const parts = token.split(".");
      if (parts.length !== 3) {
        return null;
      }
      const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8"));
      return payload as ApiKeyPayload;
    } catch {
      return null;
    }
  }
}
