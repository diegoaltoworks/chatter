import { describe, expect, test } from "bun:test";
import { decrypt, encrypt } from "./crypto";

describe("encrypt/decrypt", () => {
  test("round-trips plaintext", () => {
    const secret = "correct horse battery staple";
    const plaintext = JSON.stringify({ creds: "top-secret-session-material" });

    const ciphertext = encrypt(plaintext, secret);

    expect(ciphertext).not.toBe(plaintext);
    expect(decrypt(ciphertext, secret)).toBe(plaintext);
  });

  test("uses a fresh IV every call, so identical plaintext encrypts differently", () => {
    const secret = "same-secret";
    const plaintext = "same-plaintext";

    expect(encrypt(plaintext, secret)).not.toBe(encrypt(plaintext, secret));
  });

  test("fails to decrypt with the wrong secret", () => {
    const ciphertext = encrypt("hello", "secret-a");

    expect(() => decrypt(ciphertext, "secret-b")).toThrow();
  });

  test("fails to decrypt tampered ciphertext", () => {
    const ciphertext = encrypt("hello", "secret");
    const raw = Buffer.from(ciphertext, "base64");
    raw[raw.length - 1] ^= 0xff;
    const tampered = raw.toString("base64");

    expect(() => decrypt(tampered, "secret")).toThrow();
  });
});
