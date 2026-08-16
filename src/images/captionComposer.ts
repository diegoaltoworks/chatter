/**
 * Optional caption helper for a generated image - two tiers, no content of
 * its own.
 *
 * 1. `randomCaption()` picks from a caller-supplied template pool. Always
 *    works, costs nothing.
 * 2. `composeCaption()` runs a caller-supplied compose step (typically an LLM
 *    call) racing a timeout; any failure or timeout falls back to tier 1. It
 *    never throws.
 */

export interface CaptionRequest {
  /** What the picture is of, used to fill `{subject}` in pool templates. */
  subject: string;
  /** Arbitrary extra context a caller's compose function may use. */
  [key: string]: unknown;
}

export type CaptionComposeFn = (request: CaptionRequest) => Promise<string>;

export interface CaptionComposerOptions {
  /** Templates with an optional `{subject}` placeholder. Ships no content - always caller-supplied. */
  pool: readonly string[];
  /** Best-effort tailored caption step, e.g. wrapping an LLM call. Omit to always use the pool. */
  compose?: CaptionComposeFn;
  /** Milliseconds before `compose` is abandoned in favour of the pool. */
  timeoutMs?: number;
  /** Injectable randomness for tests. Default `Math.random`. */
  random?: () => number;
}

export interface CaptionComposer {
  randomCaption(subject?: string): string;
  composeCaption(request: CaptionRequest): Promise<string>;
}

const CAPTION_TIMEOUT_MS = 8_000;
const MAX_COMPOSED_LENGTH = 300;

export function createCaptionComposer(options: CaptionComposerOptions): CaptionComposer {
  const { pool } = options;
  const timeoutMs = options.timeoutMs ?? CAPTION_TIMEOUT_MS;
  const random = options.random ?? Math.random;

  function randomCaption(subject?: string): string {
    if (pool.length === 0) return "";
    const eligible = pool.filter((template) => subject || !template.includes("{subject}"));
    const candidates = eligible.length > 0 ? eligible : pool;
    const template = candidates[Math.floor(random() * candidates.length)] ?? candidates[0] ?? "";
    return template.replaceAll("{subject}", subject ?? "");
  }

  return {
    randomCaption,

    async composeCaption(request: CaptionRequest): Promise<string> {
      if (!options.compose) return randomCaption(request.subject);

      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const text = await Promise.race([
          options.compose(request),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("caption compose timed out")), timeoutMs);
          }),
        ]);
        const trimmed = text.trim();
        return trimmed.length > 0 && trimmed.length <= MAX_COMPOSED_LENGTH
          ? trimmed
          : randomCaption(request.subject);
      } catch {
        return randomCaption(request.subject);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
