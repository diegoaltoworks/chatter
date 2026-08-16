/**
 * Pure argv parsing for `bin/wa-pair.ts`, split out so the parsing rules are
 * unit-testable without spinning up a Baileys connection. Unrecognized flags
 * and a second positional argument fail closed rather than being silently
 * ignored (see wa-pair-args.test.ts).
 */

export type ParsedWaPairArgs =
  | { ok: true; help: true }
  | { ok: true; help: false; sessionId: string; phoneNumber?: string; reset: boolean }
  | { ok: false; error: string };

export function parseArgs(args: string[]): ParsedWaPairArgs {
  let sessionId: string | undefined;
  let codeValue: string | undefined;
  let reset = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      return { ok: true, help: true };
    }
    if (arg === "--reset") {
      reset = true;
      continue;
    }
    if (arg === "--code") {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("-")) {
        return { ok: false, error: "--code requires a phone number, e.g. --code 447700900123" };
      }
      codeValue = value;
      i++;
      continue;
    }
    if (arg.startsWith("-")) {
      return { ok: false, error: `Unknown argument: ${arg}` };
    }
    if (sessionId !== undefined) {
      return { ok: false, error: `Unexpected extra argument: ${arg}` };
    }
    sessionId = arg;
  }

  const phoneNumber = codeValue === undefined ? undefined : codeValue.replace(/[^0-9]/g, "");
  if (codeValue !== undefined && !phoneNumber) {
    return { ok: false, error: "--code requires a phone number, e.g. --code 447700900123" };
  }
  return { ok: true, help: false, sessionId: sessionId ?? "default", phoneNumber, reset };
}
