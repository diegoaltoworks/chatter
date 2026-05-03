/**
 * Markdown renderer tests
 */

import { describe, expect, test } from "bun:test";
import { escapeHtml, renderMarkdown } from "../src/markdown";

describe("escapeHtml", () => {
  test("escapes HTML-significant characters", () => {
    expect(escapeHtml("<script>alert(1)</script>")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(escapeHtml("a & b")).toBe("a &amp; b");
    expect(escapeHtml("\"quoted\" 'single'")).toBe("&quot;quoted&quot; &#39;single&#39;");
  });
});

describe("renderMarkdown - inline", () => {
  test("returns empty string for empty input", () => {
    expect(renderMarkdown("")).toBe("");
  });

  test("renders bold and italic", () => {
    expect(renderMarkdown("**bold** and *italic*")).toBe(
      "<p><strong>bold</strong> and <em>italic</em></p>",
    );
    expect(renderMarkdown("__bold__ and _italic_")).toBe(
      "<p><strong>bold</strong> and <em>italic</em></p>",
    );
  });

  test("renders inline code", () => {
    expect(renderMarkdown("use `npm install`")).toBe("<p>use <code>npm install</code></p>");
  });

  test("does not parse markdown inside inline code", () => {
    expect(renderMarkdown("`**not bold**`")).toBe("<p><code>**not bold**</code></p>");
  });

  test("renders links", () => {
    expect(renderMarkdown("[ex](https://example.com)")).toBe(
      '<p><a href="https://example.com" target="_blank" rel="noopener noreferrer">ex</a></p>',
    );
  });
});

describe("renderMarkdown - blocks", () => {
  test("renders headings", () => {
    expect(renderMarkdown("# H1")).toBe("<h1>H1</h1>");
    expect(renderMarkdown("## H2")).toBe("<h2>H2</h2>");
    expect(renderMarkdown("###### H6")).toBe("<h6>H6</h6>");
  });

  test("renders unordered lists", () => {
    expect(renderMarkdown("- a\n- b\n- c")).toBe("<ul><li>a</li><li>b</li><li>c</li></ul>");
  });

  test("renders ordered lists", () => {
    expect(renderMarkdown("1. a\n2. b")).toBe("<ol><li>a</li><li>b</li></ol>");
  });

  test("renders fenced code blocks with language class", () => {
    const result = renderMarkdown("```ts\nconst x = 1;\n```");
    expect(result).toBe('<pre><code class="language-ts">const x = 1;</code></pre>');
  });

  test("renders fenced code blocks without language", () => {
    const result = renderMarkdown("```\nplain\n```");
    expect(result).toBe("<pre><code>plain</code></pre>");
  });

  test("does not parse markdown inside fenced code blocks", () => {
    const result = renderMarkdown("```\n**not bold**\n```");
    expect(result).toBe("<pre><code>**not bold**</code></pre>");
  });

  test("renders blockquotes", () => {
    expect(renderMarkdown("> hello")).toBe("<blockquote><p>hello</p></blockquote>");
  });

  test("renders horizontal rules", () => {
    expect(renderMarkdown("---")).toBe("<hr>");
    expect(renderMarkdown("***")).toBe("<hr>");
    expect(renderMarkdown("___")).toBe("<hr>");
  });

  test("separates paragraphs by blank lines", () => {
    expect(renderMarkdown("a\n\nb")).toBe("<p>a</p><p>b</p>");
  });

  test("treats single newlines inside paragraphs as line breaks", () => {
    expect(renderMarkdown("a\nb")).toBe("<p>a<br>b</p>");
  });
});

describe("renderMarkdown - safety", () => {
  test("escapes raw HTML in plain text", () => {
    expect(renderMarkdown("<script>alert(1)</script>")).toBe(
      "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>",
    );
  });

  test("escapes HTML inside headings", () => {
    expect(renderMarkdown("# <img src=x onerror=alert(1)>")).toBe(
      "<h1>&lt;img src=x onerror=alert(1)&gt;</h1>",
    );
  });

  test("escapes HTML inside list items", () => {
    expect(renderMarkdown("- <b>hi</b>")).toBe("<ul><li>&lt;b&gt;hi&lt;/b&gt;</li></ul>");
  });

  test("escapes HTML inside code blocks", () => {
    const result = renderMarkdown("```\n<script>x</script>\n```");
    expect(result).toBe("<pre><code>&lt;script&gt;x&lt;/script&gt;</code></pre>");
  });

  test("neutralizes javascript: URLs in links", () => {
    const result = renderMarkdown("[click](javascript:alert(1))");
    expect(result).toContain('href="#"');
    expect(result).not.toContain("javascript:");
  });

  test("neutralizes data: URLs in links", () => {
    const result = renderMarkdown("[click](data:text/html,<script>x</script>)");
    expect(result).toContain('href="#"');
    expect(result).not.toContain("data:");
  });

  test("allows http, https, mailto, anchor URLs", () => {
    expect(renderMarkdown("[a](http://example.com)")).toContain('href="http://example.com"');
    expect(renderMarkdown("[a](https://example.com)")).toContain('href="https://example.com"');
    expect(renderMarkdown("[a](mailto:x@y.z)")).toContain('href="mailto:x@y.z"');
    expect(renderMarkdown("[a](#section)")).toContain('href="#section"');
  });

  test("link tags include rel and target attributes", () => {
    const result = renderMarkdown("[a](https://example.com)");
    expect(result).toContain('target="_blank"');
    expect(result).toContain('rel="noopener noreferrer"');
  });
});

describe("renderMarkdown - mixed content", () => {
  test("renders a complex assistant reply", () => {
    const input = [
      "Here are the steps:",
      "",
      "1. Install with `npm install foo`",
      "2. Import the module",
      "",
      "```js",
      'import foo from "foo";',
      "```",
      "",
      "See the [docs](https://example.com) for more.",
    ].join("\n");

    const result = renderMarkdown(input);
    expect(result).toContain("<p>Here are the steps:</p>");
    expect(result).toContain("<ol>");
    expect(result).toContain("<code>npm install foo</code>");
    expect(result).toContain('<pre><code class="language-js">');
    expect(result).toContain('href="https://example.com"');
  });
});
