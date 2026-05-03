/**
 * Lightweight, dependency-free Markdown renderer for chat messages.
 *
 * Designed to be safe: every piece of user/assistant text is HTML-escaped
 * before any markdown transformation produces tags, and URLs in links are
 * restricted to a safe scheme allowlist (http, https, mailto).
 *
 * Supports a pragmatic subset of GFM that's useful in chat:
 *  - ATX headings (# .. ######)
 *  - Bold (**x**, __x__) and italic (*x*, _x_)
 *  - Inline code (`code`) and fenced code blocks (```lang ... ```)
 *  - Links [text](url)
 *  - Unordered lists (-, *, +) and ordered lists (1.)
 *  - Blockquotes (> text)
 *  - Horizontal rules (---, ***, ___)
 *  - Paragraphs and hard line breaks
 */

const SAFE_URL_RE = /^(https?:|mailto:|\/|#)/i;
const CODE_PH_OPEN = "CODE";
const CODE_PH_CLOSE = "ENDCODE";

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sanitizeUrl(url: string): string {
  const trimmed = url.trim();
  if (!SAFE_URL_RE.test(trimmed)) return "#";
  return escapeHtml(trimmed);
}

function renderInline(escaped: string): string {
  const codeSpans: string[] = [];
  let out = escaped.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    const idx = codeSpans.push(code) - 1;
    return `${CODE_PH_OPEN}${idx}${CODE_PH_CLOSE}`;
  });

  out = out.replace(
    /\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g,
    (_m, text: string, url: string, title?: string) => {
      const safeUrl = sanitizeUrl(url);
      const titleAttr = title ? ` title="${title}"` : "";
      return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer"${titleAttr}>${text}</a>`;
    },
  );

  out = out.replace(/(\*\*|__)(?=\S)([\s\S]+?)(?<=\S)\1/g, "<strong>$2</strong>");
  out = out.replace(/(?<!\*)\*(?!\*)(?=\S)([\s\S]+?)(?<=\S)\*(?!\*)/g, "<em>$1</em>");
  out = out.replace(/(?<![A-Za-z0-9_])_(?=\S)([\s\S]+?)(?<=\S)_(?![A-Za-z0-9_])/g, "<em>$1</em>");

  const placeholderRe = new RegExp(`${CODE_PH_OPEN}(\\d+)${CODE_PH_CLOSE}`, "g");
  out = out.replace(placeholderRe, (_m, idx: string) => {
    const code = codeSpans[Number(idx)] ?? "";
    return `<code>${code}</code>`;
  });

  return out;
}

interface ListState {
  type: "ul" | "ol";
  items: string[];
}

function flushParagraph(buffer: string[], out: string[]): void {
  if (buffer.length === 0) return;
  const text = buffer.join("\n");
  const html = renderInline(escapeHtml(text)).replace(/\n/g, "<br>");
  out.push(`<p>${html}</p>`);
  buffer.length = 0;
}

function flushList(list: ListState | null, out: string[]): null {
  if (!list) return null;
  const items = list.items.map((item) => `<li>${renderInline(escapeHtml(item))}</li>`).join("");
  out.push(`<${list.type}>${items}</${list.type}>`);
  return null;
}

function flushQuote(quote: string[], out: string[]): void {
  if (quote.length === 0) return;
  const inner = renderMarkdown(quote.join("\n"));
  out.push(`<blockquote>${inner}</blockquote>`);
  quote.length = 0;
}

export function renderMarkdown(source: string): string {
  if (!source) return "";

  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  const paragraph: string[] = [];
  const quote: string[] = [];
  let list: ListState | null = null;
  let inFence = false;
  let fenceLang = "";
  let fenceBuf: string[] = [];

  const closeBlocks = () => {
    flushParagraph(paragraph, out);
    list = flushList(list, out);
    flushQuote(quote, out);
  };

  for (const line of lines) {
    if (inFence) {
      if (/^\s*```\s*$/.test(line)) {
        const code = escapeHtml(fenceBuf.join("\n"));
        const langClass = fenceLang ? ` class="language-${escapeHtml(fenceLang)}"` : "";
        out.push(`<pre><code${langClass}>${code}</code></pre>`);
        fenceBuf = [];
        fenceLang = "";
        inFence = false;
      } else {
        fenceBuf.push(line);
      }
      continue;
    }

    const fenceMatch = line.match(/^\s*```\s*([\w+-]*)\s*$/);
    if (fenceMatch) {
      closeBlocks();
      inFence = true;
      fenceLang = fenceMatch[1] || "";
      continue;
    }

    if (/^\s*$/.test(line)) {
      closeBlocks();
      continue;
    }

    if (/^\s*(?:---|\*\*\*|___)\s*$/.test(line) && paragraph.length === 0) {
      closeBlocks();
      out.push("<hr>");
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      closeBlocks();
      const level = headingMatch[1].length;
      const content = renderInline(escapeHtml(headingMatch[2].trim()));
      out.push(`<h${level}>${content}</h${level}>`);
      continue;
    }

    const quoteMatch = line.match(/^\s*>\s?(.*)$/);
    if (quoteMatch) {
      flushParagraph(paragraph, out);
      list = flushList(list, out);
      quote.push(quoteMatch[1]);
      continue;
    }
    if (quote.length > 0) flushQuote(quote, out);

    const ulMatch = line.match(/^\s*[-*+]\s+(.*)$/);
    const olMatch = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ulMatch || olMatch) {
      flushParagraph(paragraph, out);
      const type: "ul" | "ol" = ulMatch ? "ul" : "ol";
      const item = (ulMatch ? ulMatch[1] : (olMatch as RegExpMatchArray)[1]) as string;
      if (!list || list.type !== type) {
        list = flushList(list, out);
        list = { type, items: [] };
      }
      list.items.push(item);
      continue;
    }
    if (list) list = flushList(list, out);

    paragraph.push(line);
  }

  if (inFence) {
    const code = escapeHtml(fenceBuf.join("\n"));
    const langClass = fenceLang ? ` class="language-${escapeHtml(fenceLang)}"` : "";
    out.push(`<pre><code${langClass}>${code}</code></pre>`);
  }

  closeBlocks();

  return out.join("");
}
