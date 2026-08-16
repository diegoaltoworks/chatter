import { describe, expect, test } from "bun:test";
import { createMatrixApi, MatrixApiError, redactToken } from "./api";

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeFetch(
  responses: Array<{ status?: number; body?: unknown; text?: string } | (() => never)>,
) {
  const calls: RecordedCall[] = [];
  let index = 0;
  const doFetch = (async (url: string | URL, init?: RequestInit) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const rawBody = init?.body;
    const body =
      typeof rawBody === "string"
        ? (JSON.parse(rawBody) as unknown)
        : rawBody instanceof Uint8Array
          ? rawBody
          : undefined;
    calls.push({ url: String(url), method: init?.method ?? "GET", headers, body });

    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (typeof next === "function") next();
    const {
      status = 200,
      body: responseBody,
      text,
    } = next as {
      status?: number;
      body?: unknown;
      text?: string;
    };
    if (text !== undefined) return new Response(text, { status });
    return new Response(JSON.stringify(responseBody), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { doFetch, calls };
}

describe("redactToken", () => {
  test("replaces every occurrence of the token", () => {
    expect(redactToken("failed: secret-tok not authorized (secret-tok)", "secret-tok")).toBe(
      "failed: *** not authorized (***)",
    );
  });

  test("leaves text untouched for an empty token", () => {
    expect(redactToken("nothing to hide", "")).toBe("nothing to hide");
  });
});

describe("createMatrixApi", () => {
  test("rejects an empty access token at construction", () => {
    expect(() =>
      createMatrixApi({ homeserverUrl: "https://example.org", accessToken: "  " }),
    ).toThrow(/accessToken is required/);
  });

  test("rejects an empty homeserver url at construction", () => {
    expect(() => createMatrixApi({ homeserverUrl: "  ", accessToken: "tok" })).toThrow(
      /homeserverUrl is required/,
    );
  });

  test("whoami sends a bearer token and unwraps the user id", async () => {
    const { doFetch, calls } = fakeFetch([{ body: { user_id: "@bot:example.org" } }]);
    const api = createMatrixApi({
      homeserverUrl: "https://example.org",
      accessToken: "tok",
      fetch: doFetch,
    });

    await expect(api.whoami()).resolves.toEqual({ userId: "@bot:example.org" });
    expect(calls[0]?.url).toBe("https://example.org/_matrix/client/v3/account/whoami");
    expect(calls[0]?.headers.authorization).toBe("Bearer tok");
  });

  test("a trailing slash on the homeserver url does not double up", async () => {
    const { doFetch, calls } = fakeFetch([{ body: { user_id: "@bot:example.org" } }]);
    const api = createMatrixApi({
      homeserverUrl: "https://example.org/",
      accessToken: "tok",
      fetch: doFetch,
    });

    await api.whoami();
    expect(calls[0]?.url).toBe("https://example.org/_matrix/client/v3/account/whoami");
  });

  test("sync passes timeout and omits since on an initial sync, suppressing timeline replay", async () => {
    const { doFetch, calls } = fakeFetch([{ body: { next_batch: "s1" } }]);
    const api = createMatrixApi({
      homeserverUrl: "https://example.org",
      accessToken: "tok",
      fetch: doFetch,
    });

    await api.sync({ timeoutMs: 30_000 });
    const url = new URL(calls[0]?.url as string);
    expect(url.searchParams.get("since")).toBeNull();
    expect(url.searchParams.get("timeout")).toBe("30000");
    expect(JSON.parse(url.searchParams.get("filter") as string)).toEqual({
      room: { timeline: { limit: 0 } },
    });
  });

  test("sync carries a since token when resuming, without suppressing the timeline", async () => {
    const { doFetch, calls } = fakeFetch([{ body: { next_batch: "s2" } }]);
    const api = createMatrixApi({
      homeserverUrl: "https://example.org",
      accessToken: "tok",
      fetch: doFetch,
    });

    await api.sync({ since: "s1", timeoutMs: 5_000 });
    const url = new URL(calls[0]?.url as string);
    expect(url.searchParams.get("since")).toBe("s1");
    expect(url.searchParams.get("filter")).toBeNull();
  });

  test("sendEvent PUTs to a per-call unique transaction id and returns the event id", async () => {
    const { doFetch, calls } = fakeFetch([
      { body: { event_id: "$1" } },
      { body: { event_id: "$2" } },
    ]);
    const api = createMatrixApi({
      homeserverUrl: "https://example.org",
      accessToken: "tok",
      fetch: doFetch,
    });

    const first = await api.sendEvent("!room:example.org", { msgtype: "m.text", body: "hi" });
    const second = await api.sendEvent("!room:example.org", { msgtype: "m.text", body: "again" });

    expect(first).toEqual({ eventId: "$1" });
    expect(second).toEqual({ eventId: "$2" });
    expect(calls[0]?.method).toBe("PUT");
    expect(calls[0]?.url).toContain("/rooms/!room%3Aexample.org/send/m.room.message/");
    const [, txn1] = calls[0]?.url.match(/send\/m\.room\.message\/(.+)$/) ?? [];
    const [, txn2] = calls[1]?.url.match(/send\/m\.room\.message\/(.+)$/) ?? [];
    expect(txn1).not.toBe(txn2);
  });

  test("sendEvent supports a custom event type, e.g. a reaction", async () => {
    const { doFetch, calls } = fakeFetch([{ body: { event_id: "$r1" } }]);
    const api = createMatrixApi({
      homeserverUrl: "https://example.org",
      accessToken: "tok",
      fetch: doFetch,
    });

    await api.sendEvent(
      "!room:example.org",
      { "m.relates_to": { rel_type: "m.annotation", event_id: "$1", key: "👍" } },
      { eventType: "m.reaction" },
    );
    expect(calls[0]?.url).toContain("/send/m.reaction/");
  });

  test("a non-2xx response becomes a MatrixApiError carrying errcode and retry_after_ms", async () => {
    const { doFetch } = fakeFetch([
      {
        status: 429,
        body: { errcode: "M_LIMIT_EXCEEDED", error: "Too fast", retry_after_ms: 5000 },
      },
    ]);
    const api = createMatrixApi({
      homeserverUrl: "https://example.org",
      accessToken: "tok",
      fetch: doFetch,
    });

    const error = (await api.whoami().catch((e) => e)) as MatrixApiError;
    expect(error).toBeInstanceOf(MatrixApiError);
    expect(error.errcode).toBe("M_LIMIT_EXCEEDED");
    expect(error.status).toBe(429);
    expect(error.retryAfterMs).toBe(5000);
  });

  test("a transport failure never leaks the access token into the error", async () => {
    const { doFetch } = fakeFetch([
      () => {
        throw new Error("connect ECONNREFUSED https://example.org (token secret-tok)");
      },
    ]);
    const api = createMatrixApi({
      homeserverUrl: "https://example.org",
      accessToken: "secret-tok",
      fetch: doFetch,
    });

    const error = (await api.whoami().catch((e) => e)) as Error;
    expect(error).toBeInstanceOf(MatrixApiError);
    expect(error.message).not.toContain("secret-tok");
    expect(error.message).toContain("***");
  });

  test("a non-JSON error body still fails with the http status", async () => {
    const { doFetch } = fakeFetch([{ status: 502, text: "<html>bad gateway</html>" }]);
    const api = createMatrixApi({
      homeserverUrl: "https://example.org",
      accessToken: "tok",
      fetch: doFetch,
    });

    await expect(api.whoami()).rejects.toThrow(/HTTP 502/);
  });

  test("uploadMedia posts raw bytes with the content type and returns the mxc uri", async () => {
    const { doFetch, calls } = fakeFetch([{ body: { content_uri: "mxc://example.org/abc" } }]);
    const api = createMatrixApi({
      homeserverUrl: "https://example.org",
      accessToken: "tok",
      fetch: doFetch,
    });

    const bytes = new Uint8Array([1, 2, 3]);
    await expect(api.uploadMedia(bytes, "image/png", "pic.png")).resolves.toEqual({
      contentUri: "mxc://example.org/abc",
    });
    expect(calls[0]?.url).toContain("/_matrix/media/v3/upload?filename=pic.png");
    expect(calls[0]?.headers["content-type"]).toBe("image/png");
    expect(calls[0]?.body).toEqual(bytes);
  });

  test("sendMedia sends an mxc uri straight through, without fetching or uploading", async () => {
    const { doFetch, calls } = fakeFetch([{ body: { event_id: "$m1" } }]);
    const api = createMatrixApi({
      homeserverUrl: "https://example.org",
      accessToken: "tok",
      fetch: doFetch,
    });

    const result = await api.sendMedia("!room:example.org", "mxc://example.org/already-uploaded");
    expect(result).toEqual({ eventId: "$m1" });
    expect(calls.length).toBe(1);
    expect(calls[0]?.body).toMatchObject({
      msgtype: "m.image",
      url: "mxc://example.org/already-uploaded",
    });
  });

  test("sendMedia fetches an https url, uploads it, then sends the message", async () => {
    let fetchCount = 0;
    const doFetch = (async (url: string | URL, init?: RequestInit) => {
      fetchCount += 1;
      const href = String(url);
      if (href === "https://cdn.example/photo.jpg") {
        return new Response(new Uint8Array([9, 9, 9]), {
          headers: { "content-type": "image/jpeg" },
        });
      }
      if (href.includes("/_matrix/media/v3/upload")) {
        return new Response(JSON.stringify({ content_uri: "mxc://example.org/uploaded" }), {
          headers: { "content-type": "application/json" },
        });
      }
      expect(init?.method).toBe("PUT");
      return new Response(JSON.stringify({ event_id: "$m2" }), {
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const api = createMatrixApi({
      homeserverUrl: "https://example.org",
      accessToken: "tok",
      fetch: doFetch,
    });

    const result = await api.sendMedia("!room:example.org", {
      kind: "file",
      url: "https://cdn.example/photo.jpg",
      caption: "spec sheet",
    });

    expect(result).toEqual({ eventId: "$m2" });
    expect(fetchCount).toBe(3);
  });

  test("sendMedia refuses a non-https url instead of fetching it", async () => {
    const { doFetch, calls } = fakeFetch([{ body: { event_id: "$never" } }]);
    const api = createMatrixApi({
      homeserverUrl: "https://example.org",
      accessToken: "tok",
      fetch: doFetch,
    });

    for (const url of [
      "http://cdn.example/photo.jpg",
      "file:///etc/passwd",
      "data:image/png;base64,AAAA",
      "not a url",
    ]) {
      await expect(api.sendMedia("!room:example.org", url)).rejects.toThrow(TypeError);
    }
    expect(calls).toEqual([]);
  });

  test("sendMedia refuses a media source whose content-length is over the cap, before reading it", async () => {
    let fetched = 0;
    const doFetch = (async () => {
      fetched += 1;
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "image/jpeg", "content-length": "999999" },
      });
    }) as unknown as typeof fetch;
    const api = createMatrixApi({
      homeserverUrl: "https://example.org",
      accessToken: "tok",
      fetch: doFetch,
      maxMediaBytes: 1024,
    });

    await expect(
      api.sendMedia("!room:example.org", "https://cdn.example/huge.jpg"),
    ).rejects.toThrow(/over the 1024 byte cap/);
    expect(fetched).toBe(1);
  });

  test("sendMedia caps a body that streams past the limit without declaring its size", async () => {
    const doFetch = (async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(600));
          controller.enqueue(new Uint8Array(600));
          controller.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "image/jpeg" } });
    }) as unknown as typeof fetch;
    const api = createMatrixApi({
      homeserverUrl: "https://example.org",
      accessToken: "tok",
      fetch: doFetch,
      maxMediaBytes: 1024,
    });

    await expect(
      api.sendMedia("!room:example.org", "https://cdn.example/chunked.jpg"),
    ).rejects.toThrow(/exceeds the 1024 byte cap/);
  });

  test("sendMedia uploads a source that fits under the cap", async () => {
    const doFetch = (async (url: string | URL) => {
      const href = String(url);
      if (href === "https://cdn.example/small.jpg") {
        return new Response(new Uint8Array(512), { headers: { "content-type": "image/jpeg" } });
      }
      if (href.includes("/_matrix/media/v3/upload")) {
        return new Response(JSON.stringify({ content_uri: "mxc://example.org/uploaded" }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ event_id: "$m3" }), {
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const api = createMatrixApi({
      homeserverUrl: "https://example.org",
      accessToken: "tok",
      fetch: doFetch,
      maxMediaBytes: 1024,
    });

    await expect(
      api.sendMedia("!room:example.org", "https://cdn.example/small.jpg"),
    ).resolves.toEqual({ eventId: "$m3" });
  });

  test("sendMedia throws a TypeError on a payload with no url, so the registry reports false", async () => {
    const api = createMatrixApi({
      homeserverUrl: "https://example.org",
      accessToken: "tok",
      fetch: fakeFetch([]).doFetch,
    });
    await expect(api.sendMedia("!room:example.org", { caption: "no url" })).rejects.toThrow(
      TypeError,
    );
  });

  test("joinRoom POSTs to the join endpoint", async () => {
    const { doFetch, calls } = fakeFetch([{ body: { room_id: "!room:example.org" } }]);
    const api = createMatrixApi({
      homeserverUrl: "https://example.org",
      accessToken: "tok",
      fetch: doFetch,
    });

    await api.joinRoom("!room:example.org");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("https://example.org/_matrix/client/v3/join/!room%3Aexample.org");
  });

  describe("getAccountData", () => {
    test("returns the parsed content", async () => {
      const { doFetch, calls } = fakeFetch([
        { body: { "@alice:example.org": ["!dm:example.org"] } },
      ]);
      const api = createMatrixApi({
        homeserverUrl: "https://example.org",
        accessToken: "tok",
        fetch: doFetch,
      });

      await expect(api.getAccountData("@bot:example.org", "m.direct")).resolves.toEqual({
        "@alice:example.org": ["!dm:example.org"],
      });
      expect(calls[0]?.url).toBe(
        "https://example.org/_matrix/client/v3/user/%40bot%3Aexample.org/account_data/m.direct",
      );
    });

    test("resolves to undefined when the homeserver reports M_NOT_FOUND", async () => {
      const { doFetch } = fakeFetch([
        { status: 404, body: { errcode: "M_NOT_FOUND", error: "Not found" } },
      ]);
      const api = createMatrixApi({
        homeserverUrl: "https://example.org",
        accessToken: "tok",
        fetch: doFetch,
      });

      await expect(api.getAccountData("@bot:example.org", "m.direct")).resolves.toBeUndefined();
    });

    test("setAccountData PUTs the whole document back", async () => {
      const { doFetch, calls } = fakeFetch([{ body: {} }]);
      const api = createMatrixApi({
        homeserverUrl: "https://example.org",
        accessToken: "tok",
        fetch: doFetch,
      });

      await api.setAccountData("@bot:example.org", "m.direct", {
        "@alice:example.org": ["!dm:example.org"],
      });
      expect(calls[0]?.method).toBe("PUT");
      expect(calls[0]?.url).toBe(
        "https://example.org/_matrix/client/v3/user/%40bot%3Aexample.org/account_data/m.direct",
      );
      expect(calls[0]?.body).toEqual({ "@alice:example.org": ["!dm:example.org"] });
    });

    test("still rejects on a different error", async () => {
      const { doFetch } = fakeFetch([
        { status: 500, body: { errcode: "M_UNKNOWN", error: "boom" } },
      ]);
      const api = createMatrixApi({
        homeserverUrl: "https://example.org",
        accessToken: "tok",
        fetch: doFetch,
      });

      await expect(api.getAccountData("@bot:example.org", "m.direct")).rejects.toBeInstanceOf(
        MatrixApiError,
      );
    });
  });
});
