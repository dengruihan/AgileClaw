import { html, nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { markdownBlocks } from "../../../components/markdown-blocks.ts";
import { releaseMarkdownTables } from "../../../components/markdown-tables.ts";
import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import { groupMessages } from "../chat-thread-grouping.ts";
import { renderMessageGroup } from "./chat-message-group.ts";
import {
  ChatRevealBuffer,
  trackRevealLiveStream,
  type ChatRevealFrameClock,
} from "./chat-message-reveal-buffer.ts";
import { renderStreamGroup } from "./chat-message-stream.ts";

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

  it("reveals a one-shot final beside same-run commentary without a live stream", async () => {
    const harness = createRevealHarness();
    const commentaryText = "Checking the request before answering.";
    const finalText = `A one-shot final ${"that keeps arriving without a live stream. ".repeat(3).trim()}`;
    const containerCommentary = document.body.appendChild(document.createElement("div"));
    const containerFinal = document.body.appendChild(document.createElement("div"));
    const [commentaryGroup] = groupMessages([
      {
        kind: "message",
        key: "assistant:commentary",
        message: {
          role: "assistant",
          content: [{ type: "text", text: commentaryText }],
          timestamp: 1_000,
          __openclaw: { runId: "reveal-run" },
        },
      },
    ]) as MessageGroup[];
    const [finalGroup] = groupMessages([
      {
        kind: "message",
        key: "assistant:final",
        message: {
          role: "assistant",
          content: [{ type: "text", text: finalText }],
          timestamp: 2_000,
        },
      },
    ]) as MessageGroup[];
    const drawCommentary = () =>
      render(
        html`<section ${markdownBlocks()}>
          ${renderMessageGroup(commentaryGroup!, {
            showReasoning: false,
            showToolCalls: false,
            reveal: harness.buffer,
          })}
        </section>`,
        containerCommentary,
      );
    const drawFinal = () =>
      render(
        html`<section ${markdownBlocks()}>
          ${renderMessageGroup(finalGroup!, {
            showReasoning: false,
            showToolCalls: false,
            reveal: harness.buffer,
          })}
        </section>`,
        containerFinal,
      );
    const drawAll = () => {
      drawCommentary();
      drawFinal();
    };
    try {
      // stream === null: this run never streamed, so the selector records no origin.
      trackRevealLiveStream(harness.buffer, "reveal-run", null, []);
      harness.buffer.focusTail(finalGroup!, "reveal-run");
      harness.adopt(drawAll);
      drawAll();
      await Promise.resolve();
      await Promise.resolve();

      const commentaryPainted = () =>
        (containerCommentary.querySelector(".chat-text")?.textContent ?? "").trim();
      const finalPainted = () =>
        (containerFinal.querySelector(".chat-text")?.textContent ?? "").trim();
      // Commentary entries must not suppress the one-shot final reveal.
      expect(commentaryPainted().length).toBeGreaterThan(0);
      expect(commentaryPainted().length).toBeLessThan(commentaryText.length);
      expect(finalPainted().length).toBeGreaterThan(0);
      expect(finalPainted().length).toBeLessThan(finalText.length);
      expect(containerFinal.querySelector(".chat-bubble")?.classList.contains("streaming")).toBe(
        true,
      );

      await harness.drain();
      drawAll();
      await Promise.resolve();
      expect(commentaryPainted()).toBe(commentaryText);
      expect(finalPainted()).toBe(finalText);
      expect(containerFinal.querySelector(".chat-bubble")?.classList.contains("streaming")).toBe(
        false,
      );
    } finally {
      render(nothing, containerCommentary);
      render(nothing, containerFinal);
      containerCommentary.remove();
      containerFinal.remove();
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
