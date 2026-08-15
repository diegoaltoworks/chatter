import { describe, expect, it } from "bun:test";
import { matchesAllowedOrigin, matchesAllowedOriginOrLocalhost } from "./originMatch";

describe("matchesAllowedOrigin", () => {
  const allowed = ["https://example.com"];

  it("matches an exact origin", () => {
    expect(matchesAllowedOrigin("https://example.com", undefined, allowed)).toBe(true);
  });

  it("matches a referer at or under the allowed origin", () => {
    expect(matchesAllowedOrigin(undefined, "https://example.com/page", allowed)).toBe(true);
    expect(matchesAllowedOrigin(undefined, "https://example.com?x=1", allowed)).toBe(true);
    expect(matchesAllowedOrigin(undefined, "https://example.com", allowed)).toBe(true);
  });

  it("rejects a suffix-domain bypass (naive startsWith would allow this)", () => {
    expect(matchesAllowedOrigin(undefined, "https://example.com.evil.com/", allowed)).toBe(false);
    expect(matchesAllowedOrigin("https://example.com.evil.com", undefined, allowed)).toBe(false);
  });

  it("rejects an unrelated origin/referer", () => {
    expect(matchesAllowedOrigin("https://evil.com", "https://evil.com", allowed)).toBe(false);
  });
});

describe("matchesAllowedOriginOrLocalhost", () => {
  const allowed = ["https://example.com"];

  it("allows any-port localhost and 127.0.0.1 via Origin", () => {
    expect(matchesAllowedOriginOrLocalhost("http://localhost:5173", undefined, allowed)).toBe(true);
    expect(matchesAllowedOriginOrLocalhost("http://127.0.0.1:3000", undefined, allowed)).toBe(true);
  });

  it("does not treat a spoofed Host header as localhost trust — only Origin/Referer count", () => {
    // Simulates the old bug: an attacker can set Host to "localhost" freely,
    // but this function never looks at Host, so a mismatched origin still fails.
    expect(matchesAllowedOriginOrLocalhost("https://evil.com", undefined, allowed)).toBe(false);
  });

  it("falls through to the configured allowlist for non-localhost origins", () => {
    expect(matchesAllowedOriginOrLocalhost("https://example.com", undefined, allowed)).toBe(true);
    expect(matchesAllowedOriginOrLocalhost("https://not-example.com", undefined, allowed)).toBe(
      false,
    );
  });

  it("rejects a hostname that merely starts with 'localhost' (subdomain bypass)", () => {
    expect(matchesAllowedOriginOrLocalhost("http://localhost.evil.com", undefined, allowed)).toBe(
      false,
    );
  });

  it("rejects a malformed port used to smuggle a non-localhost host (suffix bypass)", () => {
    // A naive `value.startsWith("http://localhost:")` would match this.
    expect(
      matchesAllowedOriginOrLocalhost(undefined, "http://localhost:8080.evil.com/x", allowed),
    ).toBe(false);
  });

  it("rejects non-http(s) schemes even if the hostname is localhost", () => {
    expect(matchesAllowedOriginOrLocalhost("file://localhost/etc/passwd", undefined, allowed)).toBe(
      false,
    );
  });
});
