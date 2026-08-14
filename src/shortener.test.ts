import { describe, expect, test } from "bun:test";
import { createShortener, type ShortenerConfig } from "./shortener";

const config: ShortenerConfig = { apiUrl: "https://kutt.example", apiKey: "secret" };

function fetchWith(handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  return handler as unknown as typeof fetch;
}

describe("createShortener", () => {
  test("returns the shortened link on success", async () => {
    let capturedUrl = "";
    let capturedBody = "";
    let capturedApiKey = "";
    const shortener = createShortener(
      config,
      fetchWith(async (input, init) => {
        capturedUrl = String(input);
        capturedBody = String(init?.body);
        capturedApiKey = new Headers(init?.headers).get("X-API-Key") ?? "";
        return new Response(JSON.stringify({ link: "https://kutt.example/abc" }), { status: 200 });
      }),
    );

    const result = await shortener.shorten("https://example.com/very/long/path");

    expect(result).toBe("https://kutt.example/abc");
    expect(capturedUrl).toBe("https://kutt.example/api/v2/links");
    expect(capturedBody).toBe(JSON.stringify({ target: "https://example.com/very/long/path" }));
    expect(capturedApiKey).toBe("secret");
  });

  test("includes the configured domain in the request body", async () => {
    let capturedBody = "";
    const shortener = createShortener(
      { ...config, domain: "short.example" },
      fetchWith(async (_input, init) => {
        capturedBody = String(init?.body);
        return new Response(JSON.stringify({ link: "https://short.example/abc" }), { status: 200 });
      }),
    );

    await shortener.shorten("https://example.com");

    expect(capturedBody).toBe(
      JSON.stringify({ target: "https://example.com", domain: "short.example" }),
    );
  });

  test("strips a trailing slash from apiUrl", async () => {
    let capturedUrl = "";
    const shortener = createShortener(
      { ...config, apiUrl: "https://kutt.example/" },
      fetchWith(async (input) => {
        capturedUrl = String(input);
        return new Response(JSON.stringify({ link: "https://kutt.example/abc" }), { status: 200 });
      }),
    );

    await shortener.shorten("https://example.com");

    expect(capturedUrl).toBe("https://kutt.example/api/v2/links");
  });

  test("upgrades an http short link to https", async () => {
    const shortener = createShortener(
      config,
      fetchWith(
        async () =>
          new Response(JSON.stringify({ link: "http://kutt.example/abc" }), { status: 200 }),
      ),
    );

    const result = await shortener.shorten("https://example.com");

    expect(result).toBe("https://kutt.example/abc");
  });

  test("returns the original url on a non-2xx response", async () => {
    const shortener = createShortener(
      config,
      fetchWith(async () => new Response("bad request", { status: 400 })),
    );

    const result = await shortener.shorten("https://example.com");

    expect(result).toBe("https://example.com");
  });

  test("returns the original url when the response has no link", async () => {
    const shortener = createShortener(
      config,
      fetchWith(async () => new Response(JSON.stringify({}), { status: 200 })),
    );

    const result = await shortener.shorten("https://example.com");

    expect(result).toBe("https://example.com");
  });

  test("returns the original url when the link is not a string", async () => {
    const shortener = createShortener(
      config,
      fetchWith(async () => new Response(JSON.stringify({ link: 12345 }), { status: 200 })),
    );

    const result = await shortener.shorten("https://example.com");

    expect(result).toBe("https://example.com");
  });

  test("returns the original url on a malformed response body", async () => {
    const shortener = createShortener(
      config,
      fetchWith(async () => new Response("not json", { status: 200 })),
    );

    const result = await shortener.shorten("https://example.com");

    expect(result).toBe("https://example.com");
  });

  test("returns the original url on a network error", async () => {
    const shortener = createShortener(
      config,
      fetchWith(async () => {
        throw new Error("network down");
      }),
    );

    const result = await shortener.shorten("https://example.com");

    expect(result).toBe("https://example.com");
  });

  test("returns the original url on timeout", async () => {
    const shortener = createShortener(
      { ...config, timeoutMs: 5 },
      fetchWith(
        (_input, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            );
          }),
      ),
    );

    const result = await shortener.shorten("https://example.com");

    expect(result).toBe("https://example.com");
  });
});
