/**
 * Section-aware Markdown chunking.
 *
 * A pure line scanner (no Markdown parser dependency) that splits a document at
 * every ATX heading, records the heading trail each chunk sat under, and keeps
 * fenced code blocks, lists and tables whole. A section longer than the cap is
 * split on blank-line paragraph boundaries; consecutive small sections are
 * never merged.
 */

/** One chunk of a document, in reading order. */
export type SectionChunk = {
  /** The chunk's text. A section's first chunk starts with its heading line. */
  text: string;
  /** Heading trail from the H1 down; empty for text before the first heading. */
  section: string[];
  /** Zero-based index of the chunk within the document. */
  position: number;
};

type Block = { lines: string[] };

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const LIST_ITEM = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\S/;
const TABLE_DELIMITER = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

const isBlank = (line: string) => line.trim() === "";
const isIndented = (line: string) => /^(?: {2,}|\t)/.test(line);

function headingOf(line: string): { level: number; title: string } | undefined {
  const match = HEADING.exec(line);
  if (!match) return undefined;
  const title = (match[2] ?? "")
    .replace(/[ \t]+#+$/, "")
    .replace(/^#+$/, "")
    .trim();
  return { level: match[1].length, title };
}

function startsTable(lines: string[], i: number): boolean {
  return lines[i].includes("|") && i + 1 < lines.length && TABLE_DELIMITER.test(lines[i + 1]);
}

/** Index one past the end of the fenced block opening at `start`. */
function fenceEnd(lines: string[], start: number): number {
  const opener = FENCE.exec(lines[start]);
  if (!opener) return start + 1;
  const marker = opener[1];
  const closer = new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}[ \\t]*$`);
  for (let i = start + 1; i < lines.length; i++) if (closer.test(lines[i])) return i + 1;
  return lines.length;
}

/** Index one past the end of the list starting at `start`. */
function listEnd(lines: string[], start: number): number {
  let end = start + 1;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (isBlank(line)) {
      let next = i + 1;
      while (next < lines.length && isBlank(lines[next])) next++;
      if (next < lines.length && (LIST_ITEM.test(lines[next]) || isIndented(lines[next]))) {
        i = next - 1;
        continue;
      }
      break;
    }
    if (headingOf(line) && !isIndented(line)) break;
    if (FENCE.test(line) && !isIndented(line)) break;
    end = i + 1;
  }
  return end;
}

/** Index one past the end of the table starting at `start`. */
function tableEnd(lines: string[], start: number): number {
  let end = start + 2;
  while (end < lines.length && !isBlank(lines[end]) && lines[end].includes("|")) end++;
  return end;
}

/** Index one past the end of the paragraph starting at `start`. */
function paragraphEnd(lines: string[], start: number): number {
  let end = start + 1;
  while (
    end < lines.length &&
    !isBlank(lines[end]) &&
    !headingOf(lines[end]) &&
    !FENCE.test(lines[end]) &&
    !LIST_ITEM.test(lines[end])
  ) {
    end++;
  }
  return end;
}

type Section = { trail: string[]; heading?: string; blocks: Block[] };

function scan(text: string): Section[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const sections: Section[] = [{ trail: [], blocks: [] }];
  const stack: { level: number; title: string }[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const heading = FENCE.test(line) ? undefined : headingOf(line);
    if (heading) {
      while (stack.length && stack[stack.length - 1].level >= heading.level) stack.pop();
      stack.push(heading);
      sections.push({ trail: stack.map((h) => h.title), heading: line, blocks: [] });
      i++;
      continue;
    }
    let end: number;
    if (FENCE.test(line)) end = fenceEnd(lines, i);
    else if (LIST_ITEM.test(line)) end = listEnd(lines, i);
    else if (startsTable(lines, i)) end = tableEnd(lines, i);
    else end = paragraphEnd(lines, i);
    sections[sections.length - 1].blocks.push({ lines: lines.slice(i, end) });
    i = end;
  }
  return sections;
}

/**
 * Split Markdown `text` into structure-aware chunks of at most `max` characters
 * where the structure allows it.
 *
 * Every ATX heading starts a new chunk, with the heading line kept at its top.
 * A section longer than `max` is split on paragraph boundaries, each piece
 * keeping the section's trail. A fenced code block, list or table is atomic and
 * is emitted whole even if it alone exceeds `max`. Empty chunks are never
 * produced, and every non-blank input line appears in exactly one chunk, in
 * order.
 */
export function chunkSections(text: string, max = 900): SectionChunk[] {
  const cap = Math.max(1, max);
  const out: SectionChunk[] = [];
  const emit = (parts: string[], section: string[]) => {
    const body = parts.join("\n\n");
    if (body.trim() === "") return;
    out.push({ text: body, section: [...section], position: out.length });
  };

  for (const section of scan(text)) {
    let parts: string[] = section.heading ? [section.heading.trim()] : [];
    let size = parts.join("\n\n").length;
    let hasBlock = false;
    for (const block of section.blocks) {
      const piece = block.lines.join("\n");
      const added = piece.length + (parts.length ? 2 : 0);
      if (hasBlock && size + added > cap) {
        emit(parts, section.trail);
        parts = [];
        size = 0;
        hasBlock = false;
      }
      size += piece.length + (parts.length ? 2 : 0);
      parts.push(piece);
      hasBlock = true;
    }
    emit(parts, section.trail);
  }
  return out;
}
