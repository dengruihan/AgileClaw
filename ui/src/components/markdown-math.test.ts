import { describe, expect, it } from "vitest";
import {
  hasUnpairedMarkdownMath,
  MARKDOWN_MATH_DISPLAY_LIMIT,
  MARKDOWN_MATH_INLINE_LIMIT,
  markdownMathAt,
  markdownMathPlaceholderHtml,
  readMarkdownMathPlaceholder,
  renderMarkdownMathInto,
} from "./markdown-math.ts";

function placeholder(markup: string): Element {
  const container = document.createElement("div");
  container.innerHTML = markup;
  const node = container.firstElementChild;
  if (!node) {
    throw new Error("Expected a math placeholder");
  }
  return node;
}

async function typeset(source: string, display = false) {
  const container = document.createElement("div");
  const result = await renderMarkdownMathInto(container, source, display);
  return { container, result };
}

describe("markdown math delimiters", () => {
  it("matches every supported delimiter with exact content bounds", () => {
    const inlineDollar = markdownMathAt("a $x^2$ b", 2);
    expect(inlineDollar).toMatchObject({ start: 2, end: 7, display: false });
    expect("a $x^2$ b".slice(inlineDollar!.contentStart, inlineDollar!.contentEnd)).toBe("x^2");

    const displayDollar = markdownMathAt("$$\na\n$$", 0);
    expect(displayDollar).toMatchObject({ start: 0, end: 7, display: true });

    const inlineBracket = markdownMathAt(String.raw`\(\alpha\)`, 0);
    expect(inlineBracket).toMatchObject({ start: 0, end: 10, display: false });

    const displayBracket = markdownMathAt("\\[a\\]", 0);
    expect(displayBracket).toMatchObject({ start: 0, end: 5, display: true });
  });

  it("rejects currency, escaped dollars, and empty spans", () => {
    expect(markdownMathAt("$ 5", 0)).toBeNull();
    expect(markdownMathAt("$5 and $7", 0)).toBeNull();
    expect(markdownMathAt("$5$10", 0)).toBeNull();
    expect(markdownMathAt(String.raw`\$5`, 0)).toBeNull();
    expect(markdownMathAt("$$", 0)).toBeNull();
    expect(markdownMathAt(String.raw`\(\)`, 0)).toBeNull();
  });

  it("rejects one-line inline math but allows display math to span lines", () => {
    expect(markdownMathAt("$a\nb$", 0, { allowNewlines: false })).toBeNull();
    expect(markdownMathAt("$a\nb$", 0)).not.toBeNull();
  });

  it("bounds the delimited source it accepts", () => {
    expect(markdownMathAt(`$${"x".repeat(MARKDOWN_MATH_INLINE_LIMIT + 1)}$`, 0)).toBeNull();
    const longDisplay = `$$${"y".repeat(MARKDOWN_MATH_DISPLAY_LIMIT + 1)}$$`;
    expect(markdownMathAt(longDisplay, 0)).toBeNull();
  });
});

describe("markdown math streaming balance", () => {
  it("detects delimiters that never close", () => {
    expect(hasUnpairedMarkdownMath("$$\nx")).toBe(true);
    expect(hasUnpairedMarkdownMath(String.raw`opening \(x`)).toBe(true);
    expect(hasUnpairedMarkdownMath("$$x$$")).toBe(false);
    expect(hasUnpairedMarkdownMath("plain prose")).toBe(false);
  });

  it("ignores delimiters owned by a code span", () => {
    expect(hasUnpairedMarkdownMath("cost `$5` here")).toBe(false);
  });

  it("treats bare dollars in prose as openers so split appends stay safe", () => {
    expect(hasUnpairedMarkdownMath("cost $5")).toBe(true);
  });
});

describe("markdown math placeholders", () => {
  it("round-trips inline and display source out of placeholder markup", () => {
    expect(
      readMarkdownMathPlaceholder(placeholder(markdownMathPlaceholderHtml("$x^2$", false))),
    ).toEqual({ source: "x^2", display: false });
    expect(
      readMarkdownMathPlaceholder(placeholder(markdownMathPlaceholderHtml("$$\na\nb\n$$", true))),
    ).toEqual({ source: "\na\nb\n", display: true });
  });

  it("escapes authored markup inside the readable fallback", () => {
    expect(markdownMathPlaceholderHtml("$a<b$", false)).toBe(
      '<span class="markdown-math">$a&lt;b$</span>',
    );
  });
});

describe("lazy KaTeX rendering", () => {
  it("typesets a session formula with MathML and a stylesheet-backed tree", async () => {
    const { container, result } = await typeset(String.raw`\frac{a}{b} = \sqrt{c}`);
    expect(result).toBe("rendered");
    expect(container.querySelector(".katex")).not.toBeNull();
    expect(container.querySelector("math")).not.toBeNull();
  });

  it("keeps invalid TeX readable instead of throwing", async () => {
    const { container, result } = await typeset(String.raw`\frac{1}`);
    expect(result).toBe("rendered");
    expect(container.querySelector(".katex-error")).not.toBeNull();
    expect(container.textContent).toContain(String.raw`\frac{1}`);
  });

  it("refuses links and remote resources in model-authored TeX", async () => {
    for (const source of [
      String.raw`\href{javascript:alert(1)}{click}`,
      String.raw`\url{https://evil.example/payload}`,
      String.raw`\includegraphics{https://evil.example/pixel.png}`,
      String.raw`\htmlData{x=1}{y}\htmlStyle{color:red}{z}`,
    ]) {
      const { container } = await typeset(source);
      expect(container.querySelector("a"), source).toBeNull();
      expect(container.querySelector("img"), source).toBeNull();
      // Untrusted commands stay visible source text; no attribute may carry a
      // navigable or remote value.
      const attributeValues = Array.from(container.querySelectorAll("*")).flatMap((element) =>
        Array.from(element.attributes, (attribute) => attribute.value),
      );
      expect(attributeValues.join(" "), source).not.toContain("javascript:");
      expect(attributeValues.join(" "), source).not.toContain("evil.example");
      expect(container.querySelector("iframe, object, embed, style"), source).toBeNull();
    }
  });

  it("bounds the rendered display size and macro expansion", async () => {
    const huge = await typeset(`\\rule{900em}{900em}`, true);
    expect(huge.result).toBe("rendered");
    expect(huge.container.innerHTML).not.toContain("900em;");

    const expansion = await typeset(String.raw`\def\a{\a}\a`);
    expect(expansion.container.textContent).toContain(String.raw`\def\a`);
  });

  it("skips input beyond the source budget", async () => {
    const { container, result } = await typeset(`$${"z".repeat(MARKDOWN_MATH_INLINE_LIMIT + 1)}`);
    expect(result).toBe("skipped");
    expect(container.childNodes).toHaveLength(0);
  });
});
