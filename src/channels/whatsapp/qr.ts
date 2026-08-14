/**
 * `qrcode-terminal` is a plain CJS module (`module.exports = { generate, ... }`).
 * Loading it via dynamic `import()` gets interop-wrapped differently depending
 * on the runtime and how the caller itself is bundled: some expose the
 * function only under `.default`, others expose it as a named export too (or
 * only). Resolve every shape here so `wa-pair` never depends on one bundler's
 * interop guess.
 */

export type QrGenerateFn = (
  qr: string,
  options?: { small?: boolean },
  callback?: (output: string) => void,
) => void;

export interface QrTerminalModule {
  default?: { generate?: QrGenerateFn };
  generate?: QrGenerateFn;
}

/**
 * `generate` reads `this.error` internally (the module's configured error
 * correction level), so it must stay bound to the object it came from —
 * returning it detached, as a bare function reference, throws the moment it
 * runs (`this.error` is `undefined` instead of the module's setting).
 */
export function resolveQrGenerate(mod: QrTerminalModule | undefined): QrGenerateFn | undefined {
  if (!mod) return undefined;
  if (mod.default && typeof mod.default.generate === "function") {
    return mod.default.generate.bind(mod.default);
  }
  if (typeof mod.generate === "function") return mod.generate.bind(mod);
  return undefined;
}
