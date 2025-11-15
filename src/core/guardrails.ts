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
