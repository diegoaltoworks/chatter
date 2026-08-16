/**
 * Shared strength check for caller-supplied secrets (JWT signing key, WhatsApp
 * session-encryption passphrase). Both guard high-value material — API key
 * forgery or WhatsApp account takeover — so a short or empty value fails
 * fast with an actionable error instead of quietly producing a weak key.
 */

const MIN_SECRET_LENGTH = 16;

export function assertStrongSecret(
  secret: string | undefined,
  label: string,
): asserts secret is string {
  if (!secret) {
    throw new Error(`${label} is required and cannot be empty.`);
  }
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `${label} is too weak: must be at least ${MIN_SECRET_LENGTH} characters (got ${secret.length}). ` +
        "Generate one with `openssl rand -base64 32`.",
    );
  }
}
