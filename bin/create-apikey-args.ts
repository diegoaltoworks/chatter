/**
 * Pure argv parsing for `bin/create-apikey.ts`, split out so the parsing
 * rules are unit-testable without importing the side-effecting entrypoint
 * (which esbuild bundles to CJS for the published `chatter` bin - see
 * package.json's `build:bin` - so it cannot use `import.meta.main` to guard
 * itself the way a Bun-only script can).
 */

export type ParsedArgs =
  | { ok: true; help: true }
  | { ok: true; help: false; name?: string; expiresIn?: string }
  | { ok: false; error: string };

/** Unrecognized flags and missing flag values fail closed rather than being silently ignored. */
export function parseArgs(args: string[]): ParsedArgs {
  const options: { name?: string; expiresIn?: string } = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      return { ok: true, help: true };
    }
    if (arg === "--name" || arg === "--expires-in") {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("-")) {
        return { ok: false, error: `${arg} requires a value` };
      }
      if (arg === "--name") options.name = value;
      else options.expiresIn = value;
      i++;
      continue;
    }
    return { ok: false, error: `Unknown argument: ${arg}` };
  }

  return { ok: true, help: false, ...options };
}
