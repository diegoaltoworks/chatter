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
 * Apply the full output guardrails to a complete answer: refuse leaked
 * instructions outright, then scrub credentials from whatever remains.
 *
 * Used for every non-streamed answer, whoever produced it — the built-in
 * completion or a caller-supplied brain (`answerFn`).
 */
export function guardOutput(text: string): string {
  if (detectLeakage(text)) {
    return "Sorry, I can't share internal instructions. How else can I help?";
  }
  return scrubOutput(text);
}
