import DOMPurify from "dompurify";
import { html, nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { markdownBlocks } from "../../../components/markdown-blocks.ts";
import {
  handleMarkdownCodeBlockClick,
  readMarkdownCodeBlockCopyText,
} from "../../../components/markdown-code-blocks.ts";
import {
  enhanceMarkdownTables,
  releaseMarkdownTables,
} from "../../../components/markdown-tables.ts";
import { toSanitizedMarkdownHtml } from "../../../components/markdown.ts";
import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import { groupMessages } from "../chat-thread-grouping.ts";
import { renderMessageGroup } from "./chat-message-group.ts";
import {
  prepareMarkdownMedia,
  renderMarkdownMedia,
  type MarkdownMedia,
} from "./chat-message-media-markdown.ts";
import {
  ChatRevealBuffer,
  trackRevealLiveStream,
  type ChatRevealFrameClock,
} from "./chat-message-reveal-buffer.ts";
import { renderStreamGroup } from "./chat-message-stream.ts";
import { renderMessageMarkdown } from "./chat-message-text.ts";

let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(() => {
  releaseMarkdownTables(container);
  render(nothing, container);
  container.remove();
});

function renderReply(text: string, isStreaming = true, media?: MarkdownMedia) {
  render(
    html`<section ${markdownBlocks()}>
      ${renderMessageMarkdown(
        text,
        "streaming-reply",
        { role: "assistant", isStreaming },
        { codeBlockInteraction: "interactive", tableInteractions: "enabled" },
        undefined,
        media,
      )}
    </section>`,
    container,
  );
}

describe("streaming Markdown DOM", () => {
  it.each([
    { label: "paragraph", initial: "A growing reply", suffix: " with more text", selector: "p" },
    {
      label: "list",
      initial: "- First item\n- Growing item",
      suffix: " with more text",
      selector: "ul",
    },
    {
      label: "long list",
      initial: Array.from({ length: 200 }, (_, index) => `- Item ${index}`).join("\n"),
      suffix: " with more text",
      selector: "ul",
    },
    {
      label: "code fence",
      initial: "```text\nA growing block",
      suffix: " with more text",
      selector: "pre",
    },
  ])(
    "updates $label text without removing the rendered subtree",
    ({ initial, suffix, selector }) => {
      renderReply(initial);
      const existing = container.querySelector(selector);
      expect(existing).not.toBeNull();
      const records: MutationRecord[] = [];
      const observer = new MutationObserver((mutations) => records.push(...mutations));
      observer.observe(container, { childList: true, subtree: true, characterData: true });
      try {
        for (let index = 1; index <= 12; index++) {
          renderReply(initial + suffix.repeat(index));
        }
        records.push(...observer.takeRecords());
        expect(container.querySelector(selector)).toBe(existing);
        expect(records.flatMap((record) => [...record.removedNodes])).toHaveLength(0);
        expect(records.some((record) => record.type === "characterData")).toBe(true);
        expect(existing?.textContent).toContain(suffix.repeat(12));
      } finally {
        observer.disconnect();
      }
    },
  );

  it("keeps earlier list items and reader disclosure state while appending another item", () => {
    const initial =
      "- <details><summary>Evidence</summary>Retained details</details>\n- Second item";
    renderReply(initial);
    const firstItem = container.querySelector("li");
    const details = container.querySelector("details")!;
    details.open = true;
    renderReply(`${initial}\n- Third item`);
    expect(container.querySelector("li")).toBe(firstItem);
    expect(container.querySelector("details")).toBe(details);
    expect(details.open).toBe(true);
    expect(container.querySelectorAll("li")).toHaveLength(3);
  });

  it("keeps code wrap controls and updates copy content while a fence grows", async () => {
    const code = Array.from({ length: 6 }, (_, index) => `const value${index} = ${index};`).join(
      "\n",
    );
    const initial = `\`\`\`ts\n${code}`;
    renderReply(initial);
    await Promise.resolve();
    const wrapper = container.querySelector<HTMLElement>(".code-block-wrapper")!;
    const button = wrapper.querySelector<HTMLButtonElement>(".code-block-wrap")!;
    container.addEventListener("click", handleMarkdownCodeBlockClick);
    try {
      button.click();
      const extra = "\nconst seventh = 7;\nconst eighth = 8;";
      renderReply(initial + extra);
      await Promise.resolve();
      expect(container.querySelector(".code-block-wrapper")).toBe(wrapper);
      expect(wrapper.classList.contains("is-wrapped")).toBe(true);
      expect(wrapper.classList.contains("is-collapsible")).toBe(true);
      expect(button.getAttribute("aria-pressed")).toBe("true");
      const expand = wrapper.querySelector<HTMLButtonElement>(".code-block-expand")!;
      const viewport = wrapper.querySelector<HTMLElement>(".code-block-viewport")!;
      expect(viewport.id).not.toBe("");
      expect(expand.getAttribute("aria-controls")).toBe(viewport.id);
      expand.click();
      renderReply(initial + extra + "\nconst ninth = 9;");
      expect(wrapper.classList.contains("is-expanded")).toBe(true);
      expect(expand.getAttribute("aria-expanded")).toBe("true");
      expect(readMarkdownCodeBlockCopyText(wrapper.querySelector(".code-block-copy")!)).toBe(
        code + extra + "\nconst ninth = 9;",
      );
    } finally {
      container.removeEventListener("click", handleMarkdownCodeBlockClick);
    }
  });

  it("retains table controls and updates overflow as streamed cells resize", async () => {
    container.className = "chat-text";
    const initial = "| Name | Value |\n| --- | --- |\n| First | Growing";
    renderReply(initial);
    enhanceMarkdownTables(container);
    const table = container.querySelector("table");
    const icon = container.querySelector(".markdown-table__copy svg");
    expect(icon).not.toBeNull();
    renderReply(initial + " cell");
    expect(container.querySelector("table")).toBe(table);
    expect(container.querySelector(".markdown-table__copy svg")).toBe(icon);
    expect(table?.rows[1]?.cells[1]?.textContent).toBe("Growing cell");
    const shell = container.querySelector<HTMLElement>(".markdown-table")!;
    const viewport = container.querySelector<HTMLElement>(".markdown-table__viewport")!;
    viewport.style.cssText = "width: 300px; overflow-x: auto";
    table!.style.width = "max-content";
    for (const wide of [true, false]) {
      await new Promise<void>((resolve) => {
        const observer = new ResizeObserver(() => {
          observer.disconnect();
          resolve();
        });
        observer.observe(table!);
        if (wide) {
          renderReply(initial + " cell".repeat(100));
        } else {
          table!.rows[1]!.cells[1]!.textContent = "Short";
        }
      });
      expect(shell.classList.contains("markdown-table--can-scroll-right")).toBe(wide);
      expect(container.querySelector(".markdown-table__copy svg")).toBe(icon);
    }
  });

  it.each([true, false])(
    "keeps copy ownership when Expand appears (settled=%s)",
    async (settled) => {
      const initial =
        "```ts\n" +
        Array.from({ length: 6 }, (_, index) => `const value${index} = ${index};`).join("\n");
      const pending = createDeferred();
      const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: vi.fn().mockReturnValue(pending.promise) },
      });
      const fallback = vi.spyOn(document, "execCommand").mockReturnValue(true);
      vi.useFakeTimers();
      container.addEventListener("click", handleMarkdownCodeBlockClick);
      try {
        renderReply(initial);
        await Promise.resolve();
        const copy = container.querySelector<HTMLButtonElement>(".code-block-copy")!;
        const wrap = container.querySelector<HTMLButtonElement>(".code-block-wrap")!;
        wrap.click();
        const label = wrap.getAttribute("aria-label");
        copy.click();
        if (settled) {
          pending.resolve();
          await vi.advanceTimersByTimeAsync(0);
          expect(copy.classList.contains("copied")).toBe(true);
        }
        renderReply(initial + "\nconst seventh = 7;\nconst eighth = 8;");
        await Promise.resolve();
        const expand = container.querySelector<HTMLButtonElement>(".code-block-expand")!;
        expect(container.querySelector(".code-block-copy")).toBe(copy);
        expect(container.querySelector(".code-block-wrap")).toBe(wrap);
        expect(expand.getAttribute("aria-controls")).toBe(
          container.querySelector(".code-block-viewport")?.id,
        );
        pending.reject(new Error("Native clipboard unavailable"));
        await vi.advanceTimersByTimeAsync(2000);
        expect(fallback).not.toHaveBeenCalled();
        expect(wrap.getAttribute("aria-label")).toBe(label);
        expect(wrap.getAttribute("aria-pressed")).toBe("true");
        expect(expand.classList.contains("copied")).toBe(false);
        expect(expand.classList.contains("copy-failed")).toBe(false);
        expect(copy.classList.contains("copied")).toBe(false);
      } finally {
        vi.useRealTimers();
        fallback.mockRestore();
        container.removeEventListener("click", handleMarkdownCodeBlockClick);
        if (clipboard) {
          Object.defineProperty(navigator, "clipboard", clipboard);
        } else {
          Reflect.deleteProperty(navigator, "clipboard");
        }
      }
    },
  );

  it.each(["completed", "resolve", "reject"])(
    "retains control ownership when JSON controls appear after %s copy",
    async (settlement) => {
      const initial =
        '- ```json\n  {\n  "nested": {\n  "a": 1,\n  "b": 2,\n  "c": 3,\n  "d": 4,\n  "value": true\n  }\n  }';
      const pending = createDeferred();
      const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: vi.fn().mockReturnValue(pending.promise) },
      });
      const fallback = vi.spyOn(document, "execCommand").mockReturnValue(true);
      vi.useFakeTimers();
      container.addEventListener("click", handleMarkdownCodeBlockClick);
      try {
        renderReply(initial);
        await Promise.resolve();
        const wrapper = container.querySelector<HTMLElement>(".code-block-wrapper")!;
        const wrap = wrapper.querySelector<HTMLButtonElement>(".code-block-wrap")!;
        const expand = wrapper.querySelector<HTMLButtonElement>(".code-block-expand")!;
        const copy = wrapper.querySelector<HTMLButtonElement>(".code-block-copy")!;
        const copyText = readMarkdownCodeBlockCopyText(copy);
        const viewport = wrapper.querySelector(".code-block-viewport");
        wrap.click();
        expand.click();
        copy.click();
        if (settlement === "completed") {
          pending.resolve();
        }
        await vi.advanceTimersByTimeAsync(0);
        expect(copy.classList.contains("copied")).toBe(settlement === "completed");
        const wrapLabel = wrap.getAttribute("aria-label");
        renderReply(initial + "\n  ```\n\n- following");
        await Promise.resolve();
        expect(wrapper.querySelector(".code-block-json-modes")).not.toBeNull();
        expect(container.querySelector(".code-block-wrapper")).toBe(wrapper);
        expect(wrapper.querySelector(".code-block-wrap")).toBe(wrap);
        expect(wrapper.querySelector(".code-block-expand")).toBe(expand);
        expect(wrapper.querySelector(".code-block-copy")).toBe(copy);
        expect(readMarkdownCodeBlockCopyText(copy)).toBe(copyText);
        expect(wrapper.querySelector(".code-block-viewport")).toBe(viewport);
        expect(wrapper.classList.contains("is-wrapped")).toBe(true);
        expect(wrapper.classList.contains("is-expanded")).toBe(true);
        expect(wrap.getAttribute("aria-pressed")).toBe("true");
        expect(expand.getAttribute("aria-expanded")).toBe("true");
        expect(wrap.classList.contains("copied")).toBe(false);
        if (settlement === "reject") {
          pending.reject(new Error("Native clipboard unavailable"));
        } else {
          pending.resolve();
        }
        await vi.advanceTimersByTimeAsync(1500);
        expect(wrap.getAttribute("aria-label")).toBe(wrapLabel);
        expect(wrap.classList.contains("copy-failed")).toBe(false);
        expect(copy.classList.contains("copied")).toBe(false);
        expect(fallback).toHaveBeenCalledTimes(settlement === "reject" ? 1 : 0);
        const raw = wrapper.querySelector<HTMLButtonElement>('[data-json-mode="raw"]')!;
        raw.click();
        renderReply(initial + "\n  ```\n\n- following grows");
        expect(wrapper.querySelector('[data-json-mode="raw"]')).toBe(raw);
        expect(raw.getAttribute("aria-pressed")).toBe("true");
        expect(wrapper.classList.contains("is-json-raw")).toBe(true);
      } finally {
        vi.useRealTimers();
        fallback.mockRestore();
        container.removeEventListener("click", handleMarkdownCodeBlockClick);
        if (clipboard) {
          Object.defineProperty(navigator, "clipboard", clipboard);
        } else {
          Reflect.deleteProperty(navigator, "clipboard");
        }
      }
    },
  );

  it("keeps every sibling when sanitized identity hints are missing or duplicated", () => {
    const draw = (items: Array<[string | null, string]>) =>
      render(
        renderMarkdownMedia(
          DOMPurify.sanitize(
            `<section>${items.map(([key, text]) => `<p${key === null ? "" : ` data-markdown-key="${key}"`}>${text}</p>`).join("")}</section>`,
          ),
          undefined,
          true,
        ),
        container,
      );
    draw([
      ["keep", "retained"],
      ["duplicate", "first"],
      ["duplicate", "second"],
      [null, "missing"],
      ["", "empty"],
      ["3", "numeric string"],
    ]);
    const retained = container.querySelector("p");
    draw([
      [null, "new"],
      ["duplicate", "second changes"],
      ["keep", "retained"],
      ["duplicate", "first changes"],
      ["3", "numeric string"],
      ["", "empty changes"],
    ]);
    expect([...container.querySelectorAll("p")].map((node) => node.textContent)).toEqual([
      "new",
      "second changes",
      "retained",
      "first changes",
      "numeric string",
      "empty changes",
    ]);
    expect(container.querySelector('[data-markdown-key="keep"]')).toBe(retained);
    draw([
      ["duplicate", "now unique"],
      ["keep", "retained"],
      [null, "missing again"],
    ]);
    expect([...container.querySelectorAll("p")].map((node) => node.textContent)).toEqual([
      "now unique",
      "retained",
      "missing again",
    ]);
    expect(container.querySelector('[data-markdown-key="keep"]')).toBe(retained);
  });

  it("does not turn authored identity hints into interactive markup", () => {
    const source = '<button data-markdown-key="copy" class="code-block-copy">Authored</button>';
    renderReply(source);
    expect(container.querySelector("button")).toBeNull();
    expect(container.textContent).toContain(source);
  });

  it.each(["wrapped", "split"])(
    "updates %s highlighter text without replacing its list",
    (mode) => {
      const initial = "- First item\n- Growing text";
      renderReply(initial);
      const list = container.querySelector("ul");
      const [first, growing] = container.querySelectorAll("li");
      const highlight = document.createElement("mark");
      const firstText = [...first!.childNodes].find((node) => node instanceof Text)!;
      firstText.replaceWith(highlight);
      highlight.append(firstText);
      const text = [...growing!.childNodes].find((node): node is Text => node instanceof Text)!;
      if (mode === "wrapped") {
        const wrapper = document.createElement("mark");
        text.replaceWith(wrapper);
        wrapper.append(text);
      } else {
        text.splitText(4);
      }
      renderReply(initial + " continues");
      expect(container.querySelector("ul")).toBe(list);
      expect(container.querySelector("li mark")).toBe(highlight);
      expect(growing?.textContent).toBe("Growing text continues");
    },
  );

  it("clears the canonical memo when a positional node becomes a media slot", () => {
    const prepared = prepareMarkdownMedia(
      [{ type: "image", image: { url: "https://example.invalid/image.png" } }],
      () => html`<button>Media</button>`,
    );
    const draw = (source: string) =>
      render(renderMarkdownMedia(source, prepared.media, true), container);
    draw("<p>Original</p>");
    draw(prepared.markdown);
    expect(container.querySelector("button")?.textContent).toBe("Media");
    draw("<p>Original</p>");
    expect(container.querySelector("p")?.textContent).toBe("Original");
    expect(container.querySelector("button")).toBeNull();
  });

  it("refreshes media bindings with unchanged Markdown and retires removed slots", async () => {
    let policy = "allowed";
    const prepared = prepareMarkdownMedia(
      [
        { type: "text", text: "- First" },
        { type: "image", image: { url: "https://example.invalid/image.png" } },
        { type: "text", text: "- Growing" },
      ],
      () => html`<button>${policy}</button>`,
    );
    renderReply(prepared.markdown, true, prepared.media);
    const card = container.querySelector("button")!;
    expect(card.textContent).toBe("allowed");
    policy = "denied";
    renderReply(prepared.markdown, true, prepared.media);
    await Promise.resolve();
    expect(container.querySelector("button")).toBe(card);
    expect(card.textContent).toBe("denied");
    renderReply(prepared.markdown + " item", true, prepared.media);
    expect(container.querySelector("button")).toBe(card);
    renderReply(prepared.markdown + " item", false, prepared.media);
    expect(container.querySelector("button")).toBe(card);
    renderReply("Replacement without media");
    await Promise.resolve();
    expect(container.querySelector("button")).toBeNull();
    expect(card.isConnected).toBe(false);
    expect(card.parentNode).toBeNull();
  });

  it("leaves component-owned children intact and handles canonical changes", async () => {
    await import("../../../components/person-reference.ts");
    const draw = (label: string, tail: string) => {
      const source = `${label} ${tail}`;
      render(
        renderMarkdownMedia(
          toSanitizedMarkdownHtml(source, {
            humanMentions: [{ profileId: "test-person", start: 0, end: label.length }],
          }),
          undefined,
          true,
        ),
        container,
      );
    };
    draw("@Alice", "growing");
    const person = container.querySelector("openclaw-person-reference")!;
    await person.updateComplete;
    const button = person.querySelector("button");
    expect(button).not.toBeNull();
    draw("@Alice", "growing text");
    expect(container.querySelector("openclaw-person-reference")).toBe(person);
    expect(person.querySelector("button")).toBe(button);
    draw("@Bob", "new text");
    const next = container.querySelector("openclaw-person-reference")!;
    await next.updateComplete;
    expect(next.querySelector("button")?.textContent).toContain("Bob");
    expect(container.textContent).not.toContain("Alice");
  });

  it("retains enhanced Mermaid blocks until their canonical source changes", () => {
    const draw = (label: string, tail: string) =>
      render(
        renderMarkdownMedia(
          toSanitizedMarkdownHtml(
            `\`\`\`mermaid\nflowchart LR\nA[${label}] --> B\n\`\`\`\n\n${tail}`,
          ),
          undefined,
          true,
        ),
        container,
      );
    draw("First", "Growing");
    const block = container.querySelector(".markdown-mermaid")!;
    // mountMermaidBlocks hands all children to the diagram renderer.
    const diagram = document.createElement("span");
    diagram.textContent = "Enhanced diagram";
    block.replaceChildren(diagram);
    draw("First", "Growing text");
    expect(container.querySelector(".markdown-mermaid")).toBe(block);
    expect(block.firstChild).toBe(diagram);
    draw("Second", "Updated");
    expect(container.querySelector(".markdown-mermaid code")?.textContent).toContain("Second");
    expect(diagram.isConnected).toBe(false);
  });

  it("keeps the sanitizer boundary and renders void elements without swallowing siblings", () => {
    const source =
      '- [x] Checked task\n\nBefore<br>After\n\n---\n\n![Preview](data:image/png;base64,iVBORw0KGgo=)\n\n<script>alert(1)</script><img onerror="alert(1)">';
    render(
      renderMarkdownMedia(toSanitizedMarkdownHtml(source, { remoteImages: true }), undefined, true),
      container,
    );
    expect(container.querySelector("input")?.checked).toBe(true);
    expect(container.querySelector("br")).not.toBeNull();
    expect(container.querySelector("img")).not.toBeNull();
    expect(container.querySelector("hr")).not.toBeNull();
    expect(container.textContent).toContain("After");
    expect(container.querySelector("script,[onerror]")).toBeNull();
    renderReply("A **corrected** reply", false);
    expect(container.querySelector("input,img,hr")).toBeNull();
    expect(container.querySelector("strong")?.textContent).toBe("corrected");
  });
});

function createRevealHarness(options: { reducedMotion?: () => boolean } = {}) {
  let now = 1_000;
  let nextHandle = 1;
  let redraw = () => {};
  const pending = new Map<number, () => void>();
  const clock: ChatRevealFrameClock = {
    now: () => now,
    requestFrame: (callback) => {
      const handle = nextHandle++;
      pending.set(handle, callback);
      return handle;
    },
    cancelFrame: (handle) => {
      pending.delete(handle);
    },
  };
  const buffer = new ChatRevealBuffer({ clock, reducedMotion: options.reducedMotion });
  // The run is observed one projection before the text it produces arrives.
  for (const initial of [true, false]) {
    buffer.beginPass({
      sessionKey: "agent:main:main",
      runId: "reveal-run",
      live: true,
      historySettled: true,
      scheduleUpdate: initial ? () => {} : () => redraw(),
    });
  }
  return {
    buffer,
    adopt(draw: () => void) {
      redraw = draw;
    },
    get pendingFrames() {
      return pending.size;
    },
    async frame() {
      now += 16;
      const callbacks = [...pending.values()];
      pending.clear();
      for (const callback of callbacks) {
        callback();
      }
      redraw();
      await Promise.resolve();
      await Promise.resolve();
    },
    async frames(count: number) {
      for (let frame = 0; frame < count; frame += 1) {
        await this.frame();
      }
    },
    async drain(limit = 400) {
      for (let frame = 0; frame < limit && pending.size > 0; frame += 1) {
        await this.frame();
      }
    },
  };
}

function drawStreamPart(
  reveal: ChatRevealBuffer,
  text: string,
  onDraw: (draw: () => void) => void,
) {
  const draw = () =>
    render(
      html`<section ${markdownBlocks()}>
        ${renderStreamGroup(
          [
            {
              kind: "stream",
              key: "reveal-stream",
              text,
              startedAt: 1_000,
              isStreaming: true,
              runId: "reveal-run",
            },
          ],
          { sessionKey: "agent:main:main", reveal },
        )}
      </section>`,
      container,
    );
  onDraw(draw);
  draw();
}

describe("smooth assistant reveal", () => {
  it("reveals a streaming Markdown body frame by frame without replacing retained controls", async () => {
    const harness = createRevealHarness();
    const source =
      "Intro paragraph that keeps arriving with **emphasis**.\n\n```ts\nconst value = 1;\nconst next = value + 1;\n```";
    drawStreamPart(harness.buffer, source, (draw) => harness.adopt(draw));
    await Promise.resolve();

    const painted = () => (container.querySelector(".chat-text")?.textContent ?? "").trim();
    const initial = painted().length;
    expect(initial).toBeGreaterThan(0);
    expect(initial).toBeLessThan(source.length);

    const bubble = container.querySelector(".chat-bubble")!;
    expect(bubble.getAttribute("data-message-text")).toBe(source);

    await harness.frame();
    const textElement = container.querySelector(".chat-text");
    await harness.frames(3);
    expect(painted().length).toBeGreaterThan(initial);
    expect(container.querySelector(".chat-text")).toBe(textElement);
    expect(container.querySelector(".chat-bubble")).toBe(bubble);

    await harness.drain();
    expect(painted()).toContain("Intro paragraph that keeps arriving with emphasis.");
    expect(painted()).toContain("const next = value + 1;");
    expect(bubble.getAttribute("data-message-text")).toBe(source);
    expect(container.querySelector(".code-block-wrapper")).not.toBeNull();
    expect(harness.pendingFrames).toBe(0);
  });

  it("keeps the stream's reveal position when the settled final message replaces the row", async () => {
    const harness = createRevealHarness();
    const streamed = "A considered answer that keeps arriving across several frames.";
    trackRevealLiveStream(harness.buffer, "reveal-run", streamed, [
      { kind: "stream", key: "reveal-stream", isStreaming: true, runId: "reveal-run" },
    ]);
    drawStreamPart(harness.buffer, streamed, (draw) => harness.adopt(draw));
    await Promise.resolve();
    await harness.frame();
    await harness.frame();
    const paintedBeforeHandoff = (container.querySelector(".chat-text")?.textContent ?? "").trim();
    expect(paintedBeforeHandoff.length).toBeGreaterThan(0);
    expect(paintedBeforeHandoff.length).toBeLessThan(streamed.length);

    const finalText = `${streamed} It settles with **strong** emphasis.`;
    // Build the settled row through the real grouper so the renderer's group
    // key (`group:assistant:<itemKey>`) is the tail key it actually asks about.
    const [group] = groupMessages([
      {
        kind: "message",
        key: "assistant:1",
        message: {
          role: "assistant",
          content: [{ type: "text", text: finalText }],
          timestamp: 2_000,
        },
      },
    ]) as MessageGroup[];
    expect(group?.key).toBe("group:assistant:assistant:1");
    harness.buffer.focusTail({
      kind: "agent-run-frame",
      key: "reveal-frame",
      parts: [group],
      outcome: { kind: "completed", actionOwner: group.messages[0] },
    });
    harness.adopt(() =>
      render(
        html`<section ${markdownBlocks()}>
          ${renderMessageGroup(group, {
            showReasoning: false,
            showToolCalls: false,
            reveal: harness.buffer,
          })}
        </section>`,
        container,
      ),
    );
    render(
      html`<section ${markdownBlocks()}>
        ${renderMessageGroup(group, {
          showReasoning: false,
          showToolCalls: false,
          reveal: harness.buffer,
        })}
      </section>`,
      container,
    );
    await Promise.resolve();
    await Promise.resolve();

    const handedOff = (container.querySelector(".chat-text")?.textContent ?? "").trim();
    // The settled row continues from the exact text the stream row painted.
    expect(handedOff).toBe(paintedBeforeHandoff);
    expect(container.querySelector(".chat-bubble")?.classList.contains("streaming")).toBe(true);

    await harness.drain();
    const settled = (container.querySelector(".chat-text")?.textContent ?? "").trim();
    expect(settled).toBe(
      "A considered answer that keeps arriving across several frames. It settles with strong emphasis.",
    );
    expect(container.querySelector(".chat-bubble")?.classList.contains("streaming")).toBe(false);
    expect(container.querySelector("strong")?.textContent).toBe("strong");
    expect(container.querySelector(".chat-bubble")?.getAttribute("data-message-text")).toBe(
      finalText,
    );
    expect(harness.pendingFrames).toBe(0);
    expect(container.querySelectorAll(".chat-bubble")).toHaveLength(1);
  });

  it("reveals an identity-less one-shot final through the real grouped renderer", async () => {
    const harness = createRevealHarness();
    const finalText = "A one-shot grouped answer painted by the real message group renderer.";
    const [group] = groupMessages([
      {
        kind: "message",
        key: "assistant:1",
        message: {
          role: "assistant",
          content: [{ type: "text", text: finalText }],
          timestamp: 2_000,
        },
      },
    ]) as MessageGroup[];
    expect(group?.key).toBe("group:assistant:assistant:1");
    expect(group?.runId).toBeUndefined();
    harness.buffer.focusTail(group);
    expect(harness.buffer.isTail(group!.key)).toBe(true);
    const draw = () =>
      render(
        html`<section ${markdownBlocks()}>
          ${renderMessageGroup(group!, {
            showReasoning: false,
            showToolCalls: false,
            reveal: harness.buffer,
          })}
        </section>`,
        container,
      );
    harness.adopt(draw);
    draw();
    await Promise.resolve();
    await Promise.resolve();

    const painted = () => (container.querySelector(".chat-text")?.textContent ?? "").trim();
    expect(painted().length).toBeGreaterThan(0);
    expect(painted().length).toBeLessThan(finalText.length);
    expect(container.querySelector(".chat-bubble")?.classList.contains("streaming")).toBe(true);
    await harness.drain();
    expect(painted()).toBe(finalText);
    expect(container.querySelector(".chat-bubble")?.classList.contains("streaming")).toBe(false);
  });

  it("continues exactly from the single live row the production selector binds", async () => {
    const harness = createRevealHarness();
    const rowA = `Shared prefix: alpha ${"keeps growing with readable pacing. ".repeat(12)}`;
    const rowB = `Shared prefix: beta ${"is a settled same-run row. ".repeat(3)}`;
    const containerA = document.body.appendChild(document.createElement("div"));
    const containerB = document.body.appendChild(document.createElement("div"));
    const drawStreamA = () =>
      render(
        html`<section ${markdownBlocks()}>
          ${renderStreamGroup(
            [
              {
                kind: "stream",
                key: "stream-a",
                text: rowA,
                startedAt: 1_000,
                isStreaming: true,
                runId: "reveal-run",
              },
            ],
            { sessionKey: "agent:main:main", reveal: harness.buffer },
          )}
        </section>`,
        containerA,
      );
    const [settledGroupB] = groupMessages([
      {
        kind: "message",
        key: "assistant:b",
        message: {
          role: "assistant",
          content: [{ type: "text", text: rowB }],
          timestamp: 2_000,
          __openclaw: { runId: "reveal-run" },
        },
      },
    ]) as MessageGroup[];
    const drawGroupB = () =>
      render(
        html`<section ${markdownBlocks()}>
          ${renderMessageGroup(settledGroupB!, {
            showReasoning: false,
            showToolCalls: false,
            reveal: harness.buffer,
          })}
        </section>`,
        containerB,
      );
    try {
      // The production selector sees the builder's single live row.
      trackRevealLiveStream(harness.buffer, "reveal-run", rowA, [
        { kind: "stream", key: "stream-a", isStreaming: true, runId: "reveal-run" },
      ]);
      drawStreamA();
      await Promise.resolve();
      for (let frame = 0; frame < 3; frame += 1) {
        await harness.frame();
        drawStreamA();
      }
      drawGroupB();
      await Promise.resolve();
      for (let frame = 0; frame < 2; frame += 1) {
        await harness.frame();
        drawGroupB();
      }
      const paintedB = (containerB.querySelector(".chat-text")?.textContent ?? "").trim();
      expect(paintedB.length).toBeGreaterThan(0);
      expect(paintedB.length).toBeLessThan(rowB.length);
      drawStreamA();
      await Promise.resolve();
      const paintedAAtHandoff = (containerA.querySelector(".chat-text")?.textContent ?? "").trim();
      expect(paintedAAtHandoff.length).toBeGreaterThan(10);

      const finalText = `${rowA} and finishes.`;
      const [finalGroup] = groupMessages([
        {
          kind: "message",
          key: "assistant:final",
          message: {
            role: "assistant",
            content: [{ type: "text", text: finalText }],
            timestamp: 3_000,
          },
        },
      ]) as MessageGroup[];
      harness.buffer.focusTail(finalGroup!, "reveal-run");
      const drawFinal = () =>
        render(
          html`<section ${markdownBlocks()}>
            ${renderMessageGroup(finalGroup!, {
              showReasoning: false,
              showToolCalls: false,
              reveal: harness.buffer,
            })}
          </section>`,
          containerA,
        );
      harness.adopt(drawFinal);
      drawFinal();
      await Promise.resolve();
      await Promise.resolve();

      // Exact A-before/A-after continuity from the selector's single live row.
      expect((containerA.querySelector(".chat-text")?.textContent ?? "").trim()).toBe(
        paintedAAtHandoff,
      );
      // The settled sibling keeps its own reveal and is not completed by A.
      drawGroupB();
      await Promise.resolve();
      expect((containerB.querySelector(".chat-text")?.textContent ?? "").trim()).toBe(paintedB);
      await harness.frame();
      await harness.frame();
      drawGroupB();
      await Promise.resolve();
      expect(
        (containerB.querySelector(".chat-text")?.textContent ?? "").trim().length,
      ).toBeGreaterThan(paintedB.length);
    } finally {
      render(nothing, containerA);
      render(nothing, containerB);
      containerA.remove();
      containerB.remove();
    }
  });

  it("paints settled when two live rows make the predecessor ambiguous", async () => {
    const harness = createRevealHarness();
    const rowA = `Shared prefix: alpha ${"keeps growing with readable pacing. ".repeat(12)}`;
    const rowB = `Shared prefix: beta ${"is a second live row. ".repeat(3)}`;
    const containerA = document.body.appendChild(document.createElement("div"));
    const containerB = document.body.appendChild(document.createElement("div"));
    const drawStream = (target: HTMLElement, key: string, text: string) => () =>
      render(
        html`<section ${markdownBlocks()}>
          ${renderStreamGroup(
            [
              {
                kind: "stream",
                key,
                text,
                startedAt: 1_000,
                isStreaming: true,
                runId: "reveal-run",
              },
            ],
            { sessionKey: "agent:main:main", reveal: harness.buffer },
          )}
        </section>`,
        target,
      );
    try {
      drawStream(containerA, "stream-a", rowA)();
      drawStream(containerB, "stream-b", rowB)();
      await Promise.resolve();
      await harness.frame();
      drawStream(containerA, "stream-a", rowA)();
      drawStream(containerB, "stream-b", rowB)();
      await harness.frame();
      // Render the tick's paint before capturing B's mid-reveal text.
      drawStream(containerB, "stream-b", rowB)();
      drawStream(containerA, "stream-a", rowA)();
      await Promise.resolve();
      const paintedB = (containerB.querySelector(".chat-text")?.textContent ?? "").trim();
      expect(paintedB.length).toBeGreaterThan(0);
      // Both rows look live to the selector, so no origin can be proven.
      trackRevealLiveStream(harness.buffer, "reveal-run", rowA, [
        { kind: "stream", key: "stream-a", isStreaming: true, runId: "reveal-run" },
        { kind: "stream", key: "stream-b", isStreaming: true, runId: "reveal-run" },
      ]);
      const finalText = `${rowA} and finishes.`;
      const [finalGroup] = groupMessages([
        {
          kind: "message",
          key: "assistant:final",
          message: {
            role: "assistant",
            content: [{ type: "text", text: finalText }],
            timestamp: 3_000,
          },
        },
      ]) as MessageGroup[];
      harness.buffer.focusTail(finalGroup!, "reveal-run");
      const drawFinal = () =>
        render(
          html`<section ${markdownBlocks()}>
            ${renderMessageGroup(finalGroup!, {
              showReasoning: false,
              showToolCalls: false,
              reveal: harness.buffer,
            })}
          </section>`,
          containerA,
        );
      harness.adopt(drawFinal);
      drawFinal();
      await Promise.resolve();
      await Promise.resolve();
      // No origin: the final paints settled, never another row's position.
      expect((containerA.querySelector(".chat-text")?.textContent ?? "").trim()).toBe(finalText);
      expect(containerA.querySelector(".chat-bubble")?.classList.contains("streaming")).toBe(false);
      // B is untouched: not retracted and not completed by A's final.
      drawStream(containerB, "stream-b", rowB)();
      await Promise.resolve();
      expect((containerB.querySelector(".chat-text")?.textContent ?? "").trim()).toBe(paintedB);
      expect(containerB.querySelector(".chat-bubble")?.classList.contains("streaming")).toBe(true);
    } finally {
      render(nothing, containerA);
      render(nothing, containerB);
      containerA.remove();
      containerB.remove();
    }
  });

  it("paints reduced motion and history rows instantly", async () => {
    const harness = createRevealHarness({ reducedMotion: () => true });
    const source = "Instant reply with **emphasis**.";
    drawStreamPart(harness.buffer, source, (draw) => harness.adopt(draw));
    await Promise.resolve();
    expect((container.querySelector(".chat-text")?.textContent ?? "").trim()).toBe(
      "Instant reply with emphasis.",
    );
    expect(harness.pendingFrames).toBe(0);
  });
});
