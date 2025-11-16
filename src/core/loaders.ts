import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export type Bucket = "base" | "public" | "private";
export type LoadedDoc = { id: string; text: string; source: string; bucket: Bucket };

function walk(dir: string): string[] {
  const items: string[] = [];
  try {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      const st = statSync(p);
      if (st.isDirectory()) items.push(...walk(p));
      else if (p.endsWith(".md")) items.push(p);
    }
  } catch {
    /* bucket may not exist */
  }
  return items;
}

export function loadKnowledge(root = "config/knowledge"): LoadedDoc[] {
  const docs: LoadedDoc[] = [];
  for (const bucket of ["base", "public", "private"] as const) {
    const dir = join(root, bucket);
    for (const f of walk(dir)) {
      docs.push({ id: f, text: readFileSync(f, "utf8"), source: f, bucket });
    }
  }
  return docs;
}
