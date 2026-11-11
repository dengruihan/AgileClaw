import { html, nothing, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderGroupedMessage } from "./chat-message-bubble.ts";
import { prepareChatMessageRender } from "./chat-message-markdown.ts";
import baseCss from "../../../styles/base.css?inline";
import layoutCss from "../../../styles/chat/layout.css?inline";
import messageCss from "../../../styles/chat/message-layout.css?inline";
import textCss from "../../../styles/chat/text.css?inline";

const containers: HTMLElement[] = [];
const originalThemeMode = document.documentElement.getAttribute("data-theme-mode");

afterEach(() => {
  for (const container of containers.splice(0)) {
    render(nothing, container);
    container.remove();
  }
  vi.unstubAllGlobals();
  if (originalThemeMode === null) {
    document.documentElement.removeAttribute("data-theme-mode");
  } else {
    document.documentElement.setAttribute("data-theme-mode", originalThemeMode);
  }
});

function mount(text: string, isStreaming = false) {
  const container = document.body.appendChild(document.createElement("section"));
  container.style.width = "760px";
  containers.push(container);
  const draw = (markdown: string, streaming = isStreaming) => {
    render(
      html`<style>
          ${baseCss}${layoutCss}${messageCss}${textCss}
        </style>
        <div class="chat-group assistant">
          ${renderGroupedMessage(
            prepareChatMessageRender({
              role: "assistant",
              content: [{ type: "text", text: markdown }],
            }),
            "math-message",
            { isStreaming: streaming, showReasoning: false },
          )}
        </div>`,
      container,
    );
  };
  draw(text);
  return { container, draw };
}

function visibleMathText(container: HTMLElement): string {
  return Array.from(
    container.querySelectorAll(".katex-html"),
    (node) => node.textContent ?? "",
  ).join(" ");
}

async function typeset(container: HTMLElement, expected = 1): Promise<void> {
  await expect
    .poll(
      () => container.querySelectorAll('openclaw-chat-math[data-math-state="rendered"]').length,
      {
        timeout: 5_000,
      },
    )
    .toBe(expected);
}

describe("chat math rendering", () => {
  it("typesets inline and display equations inside a transcript message", async () => {
    const text = [
      String.raw`The radius is $r = \frac{d}{2}$ for this part.`,
      "",
      "$$",
      String.raw`A = \pi r^2`,
      "$$",
    ].join("\n");
    const { container } = mount(text);
    await typeset(container, 2);

    expect(container.querySelectorAll(".katex")).toHaveLength(2);
    expect(
      container.querySelector("openclaw-chat-math.openclaw-chat-math--display"),
    ).not.toBeNull();
    expect(container.querySelector(".openclaw-chat-math--display .katex-display")).not.toBeNull();
    // The rendered equation replaces the fallback source in the visible flow.
    expect(container.querySelector(".openclaw-chat-math__source")).toBeNull();
    expect(container.textContent).not.toContain("$$");
    expect(visibleMathText(container)).not.toContain("\\frac");
    expect(container.textContent).toContain("The radius is");
    // The MathML annotation keeps the authored TeX for assistive copy.
    expect(container.querySelector("annotation")?.textContent).toContain("r = \\frac{d}{2}");
  });

  it("keeps invalid TeX readable", async () => {
    const { container } = mount(String.raw`Broken $\frac{1}$ formula.`);
    await typeset(container);
    expect(container.querySelector(".katex-error")).not.toBeNull();
    expect(container.textContent).toContain(String.raw`\frac{1}`);
  });

  it("refuses navigable and remote TeX payloads", async () => {
    const { container } = mount(
      String.raw`A $\href{javascript:alert(1)}{link}$ and $\includegraphics{https://example.invalid/x.png}$ payload.`,
    );
    await typeset(container, 2);
    expect(container.querySelector("a[href^='javascript']")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(
      performance
        .getEntriesByType("resource")
        .some((entry) => entry.name.includes("example.invalid")),
    ).toBe(false);
  });

  it("typesets in table cells and blockquotes", async () => {
    const text = [
      "| Symbol | Meaning |",
      "| --- | --- |",
      String.raw`| $\pi$ | circle constant |`,
      "",
      "> Quoted claim:",
      ">",
      "> $$",
      "> e^{i\\pi} + 1 = 0",
      "> $$",
    ].join("\n");
    const { container } = mount(text);
    await typeset(container, 2);
    expect(container.querySelector("td .katex")).not.toBeNull();
    expect(container.querySelector("blockquote .katex-display")).not.toBeNull();
  });

  it("keeps typeset math in the light DOM for native selection", async () => {
    const { container } = mount(String.raw`Select $a^2 + b^2 = c^2$ here.`);
    await typeset(container);
    const math = container.querySelector("openclaw-chat-math math");
    expect(math).not.toBeNull();
    expect(math?.getRootNode()).toBe(document);
    expect(math?.textContent).toContain("2");

    const range = document.createRange();
    range.selectNodeContents(container.querySelector(".chat-text")!);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    expect(selection.toString()).toContain("Select");
    selection.removeAllRanges();
  });

  it("re-typesets a streamed equation without duplicating it", async () => {
    const { container, draw } = mount("Energy is $E = mc", true);
    await expect.poll(() => container.querySelectorAll(".markdown-math").length).toBe(0);
    expect(container.textContent).toContain("$E = mc");

    draw("Energy is $E = mc^2$ exactly.", true);
    await typeset(container);
    expect(container.querySelectorAll("openclaw-chat-math")).toHaveLength(1);
    expect(container.querySelectorAll(".katex")).toHaveLength(1);
    expect(container.textContent).not.toContain("$E = mc");
  });
});
