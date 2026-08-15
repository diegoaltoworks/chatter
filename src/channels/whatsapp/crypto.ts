/**
 * Encryption for persisted WhatsApp session material (AES-256-GCM).
 *
 * The stored auth state grants full account access, so it never touches the
 * database in plaintext. The key derives from a caller-supplied secret (any
 * strong passphrase, kept stable across restarts and deploys) via scrypt with
 * a fresh salt per ciphertext, so cracking one row's key doesn't help crack
 * another's, and offline guessing against the passphrase is far more
 * expensive than the plain sha256 hash this format replaces. scrypt runs via
 * the async, thread-pooled API — Baileys fans read/write out per key id (see
 * `authState.ts`), sometimes dozens per event, and the sync variant would
 * stall the whole process's event loop for the duration of each one.
 *
 * Payload layout: `version(1) | salt(16) | iv(12) | tag(16) | ciphertext`,
 * base64-encoded. Rows written before this format (`iv(12) | tag(16) |
 * ciphertext`, sha256-derived key, no version byte) still decrypt: every
 * caller re-encrypts on write (see `authState.ts`), so a legacy row migrates
 * to the new format the next time something rewrites it — a row Baileys never
 * touches again stays in the legacy format indefinitely, which is fine since
 * it still decrypts.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);

const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const SALT_LENGTH = 16;
const KEY_LENGTH = 32;
const VERSION = 0x01;

function deriveLegacyKey(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf-8").digest();
}

async function deriveKey(secret: string, salt: Buffer): Promise<Buffer> {
  return (await scryptAsync(secret, salt, KEY_LENGTH)) as Buffer;
}

export async function encrypt(plaintext: string, secret: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", await deriveKey(secret, salt), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  return Buffer.concat([
    Buffer.from([VERSION]),
    salt,
    iv,
    cipher.getAuthTag(),
    ciphertext,
  ]).toString("base64");
}

async function decryptVersioned(raw: Buffer, secret: string): Promise<string> {
  const salt = raw.subarray(1, 1 + SALT_LENGTH);
  const iv = raw.subarray(1 + SALT_LENGTH, 1 + SALT_LENGTH + IV_LENGTH);
  const tag = raw.subarray(1 + SALT_LENGTH + IV_LENGTH, 1 + SALT_LENGTH + IV_LENGTH + TAG_LENGTH);
  const ciphertext = raw.subarray(1 + SALT_LENGTH + IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv("aes-256-gcm", await deriveKey(secret, salt), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf-8");
}

function decryptLegacy(raw: Buffer, secret: string): string {
  const iv = raw.subarray(0, IV_LENGTH);
  const tag = raw.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = raw.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv("aes-256-gcm", deriveLegacyKey(secret), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf-8");
}

export async function decrypt(payload: string, secret: string): Promise<string> {
  const raw = Buffer.from(payload, "base64");
  // The version byte is only a fast-path hint, not the safety net: a legacy
  // row's random IV could coincidentally start with it, but AES-GCM's tag
  // check then fails the versioned attempt (odds ~1 in 2^128 of a false
  // match), so it falls back to the legacy parse either way.
  if (raw[0] === VERSION) {
    try {
      return await decryptVersioned(raw, secret);
    } catch {
      // fall through
    }
  }
  return decryptLegacy(raw, secret);
}
