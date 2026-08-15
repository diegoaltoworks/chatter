/**
 * Session-based temporary API keys for demos
 * Generates time-limited keys with request quotas
 */

import { randomUUID } from "node:crypto";

interface SessionData {
  key: string;
  created: number;
  requests: number;
  maxRequests: number;
  expiresAt: number;
  metadata?: Record<string, unknown>;
}

// In-memory session store
// In production, use Redis or similar
const sessions = new Map<string, SessionData>();

// Clean up expired sessions every 5 minutes.
//
// `unref` matters for a library: this timer is created on import, so without
// it merely importing anything that reaches this module (the root export and
// `./server` both do) keeps the host's event loop alive and their process
// never exits on its own. Unref'd, the sweep still runs for as long as the
// host is doing other work, which is exactly when sessions need sweeping.
export const sessionSweeper = setInterval(
  () => {
    const now = Date.now();
    for (const [key, data] of Array.from(sessions.entries())) {
      if (now > data.expiresAt) {
        sessions.delete(key);
      }
    }
  },
  5 * 60 * 1000,
);
sessionSweeper.unref?.();

export interface CreateSessionOptions {
  /** Max requests allowed for this session (default: 20) */
  maxRequests?: number;
  /** Session lifetime in seconds (default: 3600 = 1 hour) */
  ttl?: number;
  /** Optional metadata to store with the session */
  metadata?: Record<string, unknown>;
}

/**
 * Create a new temporary session key
 */
export function createSession(options: CreateSessionOptions = {}): SessionData {
  const { maxRequests = 20, ttl = 3600, metadata } = options;

  const key = `session_${randomUUID()}`;
  const now = Date.now();

  const session: SessionData = {
    key,
    created: now,
    requests: 0,
    maxRequests,
    expiresAt: now + ttl * 1000,
    ...(metadata && { metadata }),
  };

  sessions.set(key, session);
  return session;
}

/**
 * Validate and consume a session key
 * Returns true if valid and increments request count
 */
export function validateSession(key: string): boolean {
  const session = sessions.get(key);
  if (!session) return false;

  const now = Date.now();

  // Check expiration
  if (now > session.expiresAt) {
    sessions.delete(key);
    return false;
  }

  // Check quota
  if (session.requests >= session.maxRequests) {
    return false;
  }

  // Increment and allow
  session.requests++;
  return true;
}

/**
 * Get session info (for debugging)
 */
export function getSessionInfo(key: string): SessionData | null {
  return sessions.get(key) || null;
}

/**
 * Get total active sessions (for monitoring)
 */
export function getActiveSessions(): number {
  return sessions.size;
}
