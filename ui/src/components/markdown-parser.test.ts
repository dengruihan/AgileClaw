import { describe, expect, it } from "vitest";
import { MARKDOWN_MATH_DISPLAY_CLASS } from "./markdown-math.ts";
import { createMarkdownParser } from "./markdown-parser.ts";

const parser = createMarkdownParser();

function render(markdown: string): string {
  return parser.render(markdown, {});
}

function mathSpans(markdown: string): string[] {
  const container = document.createElement("div");
  container.innerHTML = render(markdown);
  return Array.from(container.querySelectorAll(".markdown-math"), (node) => node.textContent ?? "");
}

function displayBlocks(markdown: string): string[] {
  const container = document.createElement("div");
  container.innerHTML = render(markdown);
  return Array.from(
    container.querySelectorAll(`.${MARKDOWN_MATH_DISPLAY_CLASS}`),
    (node) => node.textContent ?? "",
  );
}

describe("markdown math parsing", () => {
  it("marks inline dollar math with its exact source", () => {
    expect(render("The energy is $E = mc^2$ exactly.")).toBe(
      '<p>The energy is <span class="markdown-math">$E = mc^2$</span> exactly.</p>\n',
    );
  });

  it("keeps TeX escapes and commands verbatim inside inline math", () => {
    expect(mathSpans(String.raw`Ratio $\frac{a\,b}{c} < 1$ holds.`)).toEqual([
      String.raw`$\frac{a\,b}{c} < 1$`,
    ]);
    expect(render(String.raw`Ratio $\frac{a\,b}{c} < 1$ holds.`)).toContain("&lt; 1$</span>");
  });

  it("renders a fenced display block as one placeholder with delimiter lines", () => {
    const markdown = ["Before", "", "$$", String.raw`\int_0^1 x^2\,dx`, "$$", "", "After"].join(
      "\n",
    );
    expect(displayBlocks(markdown)).toEqual(["$$\n\\int_0^1 x^2\\,dx\n$$"]);
    expect(render(markdown)).toContain(
      '<div class="markdown-math markdown-math--display">$$\n\\int_0^1 x^2\\,dx\n$$</div>',
    );
  });

  it("supports a single-line display block", () => {
    expect(displayBlocks("$$ x^2 + y^2 = z^2 $$")).toEqual(["$$ x^2 + y^2 = z^2 $$"]);
  });

  it("supports backslash inline and display delimiters", () => {
    expect(mathSpans(String.raw`A \(\alpha + \beta\) pairing.`)).toEqual([
      String.raw`\(\alpha + \beta\)`,
    ]);
    expect(displayBlocks(["\\[", String.raw`\sum_{i=1}^n i`, "\\]"].join("\n"))).toEqual([
      "\\[\n\\sum_{i=1}^n i\n\\]",
    ]);
  });

  it("tokenizes math inside table cells", () => {
    const markdown = ["| Symbol | Meaning |", "| --- | --- |", "| $\\pi$ | circle |"].join("\n");
    const container = document.createElement("div");
    container.innerHTML = render(markdown);
    const cells = Array.from(container.querySelectorAll("td"), (cell) => cell.innerHTML);
    expect(cells[0]).toBe('<span class="markdown-math">$\\pi$</span>');
    expect(cells[1]).toBe("circle");
  });

  it("tokenizes display math inside a blockquote", () => {
    const markdown = ["> Claim:", ">", "> $$", "> a^2 + b^2 = c^2", "> $$"].join("\n");
    const container = document.createElement("div");
    container.innerHTML = render(markdown);
    const block = container.querySelector(`blockquote .${MARKDOWN_MATH_DISPLAY_CLASS}`);
    expect(block?.textContent).toBe("$$\na^2 + b^2 = c^2\n$$");
  });

  it("leaves code spans and fenced code untouched", () => {
    expect(mathSpans("Use `$cost$` here.")).toEqual([]);
    expect(render("`$cost$`")).toContain("<code>$cost$</code>");
    const fenced = ["```bash", 'echo "$HOME and $PATH"', "```"].join("\n");
    expect(mathSpans(fenced)).toEqual([]);
    expect(render(fenced)).toContain("$HOME and $PATH");
  });

  it("leaves escaped dollars literal", () => {
    expect(mathSpans(String.raw`Costs \$5 and \$9.`)).toEqual([]);
    expect(render(String.raw`Costs \$5 and \$9.`)).toContain("$5 and $9.");
  });

  it("tokenizes numeric-leading formulas", () => {
    expect(mathSpans("$2+2=4$")).toEqual(["$2+2=4$"]);
    expect(mathSpans("Sales grew by $2+2=4$ overall.")).toEqual(["$2+2=4$"]);
    expect(mathSpans("$1/2$ and $2^8$")).toEqual(["$1/2$", "$2^8$"]);
    expect(render("$2+2=4$")).toBe('<p><span class="markdown-math">$2+2=4$</span></p>\n');
  });

  it("tokenizes implicit multiplication and factorials after a number", () => {
    expect(mathSpans("$2x$")).toEqual(["$2x$"]);
    expect(mathSpans("$2xy$")).toEqual(["$2xy$"]);
    expect(mathSpans("$2(x)$")).toEqual(["$2(x)$"]);
    expect(mathSpans("$2!$")).toEqual(["$2!$"]);
    expect(mathSpans("$2.5x$")).toEqual(["$2.5x$"]);
    expect(mathSpans("The area is $2xy$ square units.")).toEqual(["$2xy$"]);
    expect(render("$2(x)$")).toBe('<p><span class="markdown-math">$2(x)$</span></p>\n');
  });

  it("still finds a closer after repeated currency amounts", () => {
    // The bounded scan must not skip a valid closer inside the budget.
    const amounts = "$5 and $10, ".repeat(20);
    expect(mathSpans(`${amounts}$x+1$`)).toEqual(["$x+1$"]);
    expect(mathSpans(`${amounts}$2x$`)).toEqual(["$2x$"]);
  });

  it("keeps prose that merely starts with a number literal", () => {
    expect(mathSpans("$2x marks the spot$")).toEqual([]);
    expect(mathSpans("Fees grew $5 and $10 today.")).toEqual([]);
    expect(mathSpans("It costs $5$ per seat.")).toEqual([]);
  });

  it("keeps amounts literal next to a later formula", () => {
    expect(mathSpans("The fee is $5 today. Then $x$ costs more.")).toEqual(["$x$"]);
    expect(mathSpans("$5 and $10, plus $1.50, and $5$10.")).toEqual([]);
  });

  it("leaves ordinary currency and prose dollars alone", () => {
    expect(mathSpans("$5 and $10 are different amounts.")).toEqual([]);
    expect(mathSpans("Price: $1.50 per item.")).toEqual([]);
    expect(mathSpans("Budget $5,000 total.")).toEqual([]);
    expect(mathSpans("$x$2 is not a formula.")).toEqual([]);
  });

  it("keeps unclosed delimiters readable", () => {
    expect(mathSpans("An open $$ block")).toEqual([]);
    expect(render("An open $$ block")).toContain("An open $$ block");
    // CommonMark escaping still owns unmatched delimiters.
    expect(render(String.raw`Unclosed \(x + 1`)).toContain("Unclosed (x + 1");
    expect(mathSpans(String.raw`Unclosed \(x + 1`)).toEqual([]);
  });

  it("keeps math on one line only for inline delimiters", () => {
    const html = render("$a\nb$");
    expect(mathSpans("$a\nb$")).toEqual([]);
    expect(html).toContain("$a<br>");
  });

  it("bounds inline and display source lengths", () => {
    const longInline = `$${"x".repeat(1_100)}$`;
    expect(mathSpans(longInline)).toEqual([]);
    const longDisplay = ["$$", "y".repeat(4_200), "$$"].join("\n");
    expect(displayBlocks(longDisplay)).toEqual([]);
  });

  it("bounds the number of display lines", () => {
    const lines = ["$$", ...Array.from({ length: 70 }, () => "a"), "$$"];
    expect(displayBlocks(lines.join("\n"))).toEqual([]);
  });

  it("does not interpret math inside link destinations", () => {
    const container = document.createElement("div");
    container.innerHTML = render("[plan](https://example.com/$5-to-$9)");
    expect(container.querySelector(".markdown-math")).toBeNull();
    expect(container.querySelector("a")?.getAttribute("href")).toBe("https://example.com/$5-to-$9");
  });
});
