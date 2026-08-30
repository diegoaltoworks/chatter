export function detectLeakage(text: string): boolean {
  const flags = [
    /system prompt/i,
    /hidden instruction/i,
    /here (are|is) (my|the) rules/i,
    /BEGIN SYSTEM PROMPT/i,
    /tool instructions/i,
  ];
  return flags.some((rx) => rx.test(text));
}

export function scrubOutput(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9]{15,}/g, "[REDACTED]")
    .replace(/AIza[0-9A-Za-z_-]{30,}/g, "[REDACTED]");
}

/**
 * The refusal sent when leaked instructions are detected and no host has
 * supplied its own wording.
 */
export const DEFAULT_REFUSAL = "Sorry, I can't share internal instructions. How else can I help?";

/**
 * Apply the full output guardrails to a complete answer: refuse leaked
 * instructions outright, then scrub credentials from whatever remains.
 *
 * Used for every non-streamed answer, whoever produced it — the built-in
 * completion or a caller-supplied brain (`answerFn`).
 *
 * `refusal` only replaces the wording of the refusal. Detection and scrubbing
 * are not configurable, so a host can voice the guard but never weaken it; a
 * blank or non-string `refusal` falls back to `DEFAULT_REFUSAL` rather than
 * letting a host silence the refusal by supplying an empty line.
 */
export function guardOutput(text: string, refusal?: string): string {
  if (detectLeakage(text)) {
    return typeof refusal === "string" && refusal.trim() ? refusal : DEFAULT_REFUSAL;
  }
  return scrubOutput(text);
}
