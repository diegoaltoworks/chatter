import { describe, expect, test } from "bun:test";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { decrypt, encrypt } from "./crypto";

/** The pre-hardening format: sha256(secret) key, no salt, no version byte. */
function legacyEncrypt(plaintext: string, secret: string): string {
  const key = createHash("sha256").update(secret, "utf-8").digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
}

describe("encrypt/decrypt", () => {
  test("round-trips plaintext", async () => {
    const secret = "correct horse battery staple";
    const plaintext = JSON.stringify({ creds: "top-secret-session-material" });

    const ciphertext = await encrypt(plaintext, secret);

    expect(ciphertext).not.toBe(plaintext);
    expect(await decrypt(ciphertext, secret)).toBe(plaintext);
  });

  test("uses a fresh IV every call, so identical plaintext encrypts differently", async () => {
    const secret = "same-secret";
    const plaintext = "same-plaintext";

    expect(await encrypt(plaintext, secret)).not.toBe(await encrypt(plaintext, secret));
  });

  test("fails to decrypt with the wrong secret", async () => {
    const ciphertext = await encrypt("hello", "secret-a");

    await expect(decrypt(ciphertext, "secret-b")).rejects.toThrow();
  });

  test("fails to decrypt tampered ciphertext", async () => {
    const ciphertext = await encrypt("hello", "secret");
    const raw = Buffer.from(ciphertext, "base64");
    raw[raw.length - 1] ^= 0xff;
    const tampered = raw.toString("base64");

    await expect(decrypt(tampered, "secret")).rejects.toThrow();
  });

  test("new payloads are versioned and carry a per-row salt ahead of the IV/tag", async () => {
    const raw = Buffer.from(await encrypt("hello", "some-strong-secret"), "base64");

    expect(raw[0]).toBe(0x01);
    // version(1) + salt(16) + iv(12) + tag(16) header, before any ciphertext
    expect(raw.length).toBeGreaterThanOrEqual(45);
  });

  test("each encryption gets its own random salt", async () => {
    const secret = "some-strong-secret";
    const a = Buffer.from(await encrypt("same-plaintext", secret), "base64");
    const b = Buffer.from(await encrypt("same-plaintext", secret), "base64");

    expect(a.subarray(1, 17).equals(b.subarray(1, 17))).toBe(false);
  });

  test("the salt is load-bearing in key derivation (KDF), not inert padding", async () => {
    const secret = "some-strong-secret";
    const a = Buffer.from(await encrypt("same-plaintext", secret), "base64");
    const b = Buffer.from(await encrypt("same-plaintext", secret), "base64");
    // Graft b's salt onto a's version/iv/tag/ciphertext. If the salt weren't
    // part of the derived key, this would still decrypt correctly.
    const grafted = Buffer.concat([a.subarray(0, 1), b.subarray(1, 17), a.subarray(17)]);

    await expect(decrypt(grafted.toString("base64"), secret)).rejects.toThrow();
  });

  test("decrypts legacy (unsalted sha256) rows for backward compatibility", async () => {
    const secret = "correct horse battery staple";
    const plaintext = JSON.stringify({ creds: "legacy-session-material" });

    expect(await decrypt(legacyEncrypt(plaintext, secret), secret)).toBe(plaintext);
  });

  test("re-encrypting a legacy row transparently upgrades it to the versioned format", async () => {
    const secret = "correct horse battery staple";
    const plaintext = "legacy-then-migrated";
    const legacy = legacyEncrypt(plaintext, secret);

    const migrated = await encrypt(await decrypt(legacy, secret), secret);

    expect(Buffer.from(migrated, "base64")[0]).toBe(0x01);
    expect(await decrypt(migrated, secret)).toBe(plaintext);
  });
});
