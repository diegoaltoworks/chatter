/**
 * URL shortening against a Kutt-compatible API, config-injected (no
 * `process.env` reads) so hosts can wire credentials however they like.
 *
 * The hard invariant: {@link Shortener.shorten} never throws. Any failure
 * (a network error, an aborted request past `timeoutMs`, or a
 * non-2xx/malformed response) resolves to the original URL instead, since a
 * shortener outage must never break something user-facing that only wanted
 * a shorter link.
 */

export interface ShortenerConfig {
  /** Base URL of the Kutt (or Kutt-compatible) instance, e.g. "https://kutt.it". */
  apiUrl: string;
  apiKey: string;
  /** Custom short domain configured on the Kutt instance, if any. */
  domain?: string;
  /** Abort the request after this many milliseconds. Defaults to 5000. */
  timeoutMs?: number;
}

export interface Shortener {
  /** Resolves to the shortened URL, or the input `url` unchanged on any failure. */
  shorten(url: string): Promise<string>;
}

const SHORTENER_TIMEOUT_MS = 5000;

interface KuttLinkResponse {
  link?: string;
}

export function createShortener(
  config: ShortenerConfig,
  fetchImpl: typeof fetch = fetch,
): Shortener {
  const apiUrl = config.apiUrl.replace(/\/+$/, "");

  return {
    async shorten(url: string): Promise<string> {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        config.timeoutMs ?? SHORTENER_TIMEOUT_MS,
      );

      try {
        const response = await fetchImpl(`${apiUrl}/api/v2/links`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-Key": config.apiKey,
          },
          body: JSON.stringify({ target: url, domain: config.domain }),
          signal: controller.signal,
        });

        if (!response.ok) {
          await response.text().catch(() => "");
          return url;
        }

        const data = (await response.json()) as KuttLinkResponse;
        if (typeof data.link !== "string") return url;

        // Upgrade a plain-http short link to https so a downstream consumer
        // never re-emits it, even against a Kutt instance not fronted by TLS.
        return data.link.replace(/^http:\/\//, "https://");
      } catch {
        return url;
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
