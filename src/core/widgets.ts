/**
 * Static Assets Resolution
 *
 * Finds the static assets directory (chatter.js, chatter.css, etc.)
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface StaticResolution {
  /** Path to static assets directory, or null if not found */
  staticDir: string | null;
}

/**
 * Find the static assets directory
 * @param configStaticDir - Optional explicit path from config
 */
export function resolveStatic(configStaticDir?: string): StaticResolution {
  // Explicit config
  if (configStaticDir && existsSync(configStaticDir)) {
    return { staticDir: configStaticDir };
  }

  // Try ESM import.meta.url
  try {
    // @ts-ignore
    if (import.meta.url) {
      // @ts-ignore
      const moduleDir = dirname(fileURLToPath(import.meta.url));
      const staticDir = join(moduleDir, "static");
      if (existsSync(staticDir)) return { staticDir };
    }
  } catch {}

  // Try CJS __dirname
  try {
    // @ts-ignore
    if (typeof __dirname !== "undefined") {
      // @ts-ignore
      const staticDir = join(__dirname, "static");
      if (existsSync(staticDir)) return { staticDir };
    }
  } catch {}

  return { staticDir: null };
}
