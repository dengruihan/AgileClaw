/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import {
  ChatRevealBuffer,
  snapRevealIndex,
  type ChatRevealFrameClock,
} from "./chat-message-reveal-buffer.ts";

function createFrameClock() {
  let now = 1_000;
  let nextHandle = 1;
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
  return {
    clock,
    advance(frames = 1, deltaMs = 16) {
      for (let frame = 0; frame < frames; frame += 1) {
        now += deltaMs;
        const callbacks = [...pending.values()];
        pending.clear();
        for (const callback of callbacks) {
          callback();
        }
      }
    },
    get pendingFrames() {
      return pending.size;
    },
  };
}

function createBuffer(options: { reducedMotion?: () => boolean } = {}) {
  const frames = createFrameClock();
  const scheduleUpdate = vi.fn();
  const buffer = new ChatRevealBuffer({
    clock: frames.clock,
    reducedMotion: options.reducedMotion ?? (() => false),
  });
  // A live run is observed in an earlier projection than the text it produces;
  // the second pass is the one that arms the reveal.
  for (const pass of [0, 1]) {
    buffer.beginPass({
      sessionKey: "agent:main:main",
      runId: "run-1",
      live: true,
      historySettled: true,
      scheduleUpdate: pass === 0 ? () => {} : scheduleUpdate,
    });
  }
  return { buffer, frames, scheduleUpdate };
}

const REPLY = "First line of the answer.\nSecond line continues here.";

describe("chat reveal buffer", () => {
  it("reveals an arriving chunk gradually, pauses when caught up, and resumes on later text", () => {
    const { buffer, frames, scheduleUpdate } = createBuffer();
    const first = buffer.visibleText({ key: "live", runId: "run-1", text: REPLY, streaming: true });

    expect(first.revealing).toBe(true);
    expect(first.text.length).toBeGreaterThan(0);
    expect(first.text.length).toBeLessThan(REPLY.length);
    expect(REPLY.startsWith(first.text)).toBe(true);

    const lengths = [first.text.length];
    for (
      let frame = 0;
      frame < 400 &&
      buffer.visibleText({ key: "live", runId: "run-1", text: REPLY, streaming: true }).revealing;
      frame += 1
    ) {
      frames.advance();
      lengths.push(
        buffer.visibleText({ key: "live", runId: "run-1", text: REPLY, streaming: true }).text
          .length,
      );
    }
    expect(lengths.every((length) => length > 0)).toBe(true);
    expect(lengths.toSorted((a, b) => a - b)).toEqual(lengths);
    expect(
      buffer.visibleText({ key: "live", runId: "run-1", text: REPLY, streaming: true }),
    ).toEqual({
      text: REPLY,
      revealing: false,
    });
    expect(scheduleUpdate).toHaveBeenCalled();
    expect(frames.pendingFrames).toBe(0);

    frames.advance(5);
    expect(
      buffer.visibleText({ key: "live", runId: "run-1", text: REPLY, streaming: true }).text,
    ).toBe(REPLY);
    expect(frames.pendingFrames).toBe(0);

    const longer = `${REPLY} One more sentence arrives.`;
    const resumed = buffer.visibleText({
      key: "live",
      runId: "run-1",
      text: longer,
      streaming: true,
    });
    expect(resumed.revealing).toBe(true);
    expect(resumed.text.length).toBeGreaterThanOrEqual(REPLY.length);
    expect(longer.startsWith(resumed.text)).toBe(true);
    frames.advance(400);
    expect(
      buffer.visibleText({ key: "live", runId: "run-1", text: longer, streaming: true }).text,
    ).toBe(longer);
  });

  it("keeps the final message on the stream's reveal position instead of restarting", () => {
    const { buffer, frames } = createBuffer();
    const streamText = "A considered answer that keeps arriving";
    buffer.visibleText({ key: "stream-row", runId: "run-1", text: streamText, streaming: true });
    frames.advance(2);
    const painted = buffer.visibleText({
      key: "stream-row",
      runId: "run-1",
      text: streamText,
      streaming: true,
    });
    expect(painted.revealing).toBe(true);

    const finalText = `${streamText} until it is complete.`;
    const handedOff = buffer.visibleText({
      key: "message-row",
      runId: "run-1",
      text: finalText,
      streaming: false,
    });
    expect(handedOff.revealing).toBe(true);
    expect(handedOff.text).toBe(painted.text);
    expect(buffer.visibleText({ key: "stream-row", runId: "run-1", text: streamText })).toEqual({
      text: streamText,
      revealing: false,
    });

    frames.advance(400);
    expect(
      buffer.visibleText({ key: "message-row", runId: "run-1", text: finalText, streaming: false }),
    ).toEqual({ text: finalText, revealing: false });
    expect(frames.pendingFrames).toBe(0);
  });

  it("drains a long one-shot final inside a bounded frame budget with exact text", () => {
    const { buffer, frames } = createBuffer();
    const long = `${"Paragraph text with **emphasis** and `code` spans.\n\n".repeat(160)}END`;
    expect(long.length).toBeGreaterThan(8_000);
    buffer.visibleText({ key: "one-shot", runId: "run-1", text: long, streaming: false });
    let rendered = buffer.visibleText({ key: "one-shot", runId: "run-1", text: long });
    let frameCount = 0;
    while (rendered.revealing) {
      frames.advance();
      rendered = buffer.visibleText({ key: "one-shot", runId: "run-1", text: long });
      frameCount += 1;
      expect(long.startsWith(rendered.text)).toBe(true);
    }
    expect(frameCount).toBeLessThan(260);
    expect(rendered.text).toBe(long);
  });

  it("paints history and reduced motion immediately without scheduling frames", () => {
    const frames = createFrameClock();
    const scheduleUpdate = vi.fn();
    const buffer = new ChatRevealBuffer({
      clock: frames.clock,
      reducedMotion: () => true,
    });
    buffer.beginPass({
      sessionKey: "agent:main:main",
      runId: "run-1",
      live: true,
      historySettled: true,
      scheduleUpdate,
    });
    expect(
      buffer.visibleText({ key: "live", runId: "run-1", text: REPLY, streaming: true }),
    ).toEqual({
      text: REPLY,
      revealing: false,
    });
    expect(frames.pendingFrames).toBe(0);
    expect(scheduleUpdate).not.toHaveBeenCalled();

    const { buffer: historyBuffer, frames: historyFrames } = createBuffer();
    expect(historyBuffer.visibleText({ key: "old", runId: "run-previous", text: REPLY })).toEqual({
      text: REPLY,
      revealing: false,
    });
    historyFrames.advance(4);
    expect(historyFrames.pendingFrames).toBe(0);
  });

  it("animates only the focused tail row when a settled answer has no run id", () => {
    const { buffer } = createBuffer();
    buffer.focusTail({
      kind: "agent-run-frame",
      key: "answer-frame",
      parts: [{ kind: "group", key: "answer-group" }],
    });
    expect(buffer.isTail("answer-group")).toBe(true);
    expect(buffer.isTail("history-group")).toBe(false);
    expect(
      buffer.visibleText({
        key: "answer-group",
        text: REPLY,
        streaming: false,
        liveTail: buffer.isTail("answer-group"),
      }).revealing,
    ).toBe(true);
    expect(
      buffer.visibleText({
        key: "history-group",
        text: REPLY,
        streaming: false,
        liveTail: buffer.isTail("history-group"),
      }),
    ).toEqual({ text: REPLY, revealing: false });
    expect(buffer.focusTail(null)).toBeNull();
    expect(buffer.isTail("answer-group")).toBe(true);
  });

  it("paints settled text when the host cannot report a motion preference", () => {
    // jsdom (and other non-browser hosts) expose no matchMedia; missing motion
    // metadata must not animate.
    const frames = createFrameClock();
    const buffer = new ChatRevealBuffer({ clock: frames.clock });
    buffer.beginPass({
      sessionKey: "agent:main:main",
      runId: "run-1",
      live: true,
      historySettled: true,
      scheduleUpdate: () => {},
    });
    expect(
      buffer.visibleText({ key: "live", runId: "run-1", text: REPLY, streaming: true }),
    ).toEqual({
      text: REPLY,
      revealing: false,
    });
    expect(frames.pendingFrames).toBe(0);
  });

  it("paints an attached run's existing backlog and animates only later growth", () => {
    const frames = createFrameClock();
    const buffer = new ChatRevealBuffer({ clock: frames.clock, reducedMotion: () => false });
    buffer.beginPass({
      sessionKey: "agent:main:main",
      runId: "run-1",
      live: true,
      historySettled: false,
      scheduleUpdate: () => {},
    });
    const attachment = "Output produced before this pane attached.";
    expect(
      buffer.visibleText({ key: "live", runId: "run-1", text: attachment, streaming: true }),
    ).toEqual({ text: attachment, revealing: false });
    expect(frames.pendingFrames).toBe(0);

    buffer.beginPass({
      sessionKey: "agent:main:main",
      runId: "run-1",
      live: true,
      historySettled: true,
      scheduleUpdate: () => {},
    });
    const grown = `${attachment} Then a live delta.`;
    const afterGrowth = buffer.visibleText({
      key: "live",
      runId: "run-1",
      text: grown,
      streaming: true,
    });
    expect(afterGrowth.revealing).toBe(true);
    expect(afterGrowth.text).toBe(attachment);
    frames.advance(200);
    expect(
      buffer.visibleText({ key: "live", runId: "run-1", text: grown, streaming: true }).text,
    ).toBe(grown);
  });

  it("keeps the shared prefix and never duplicates text when the canonical body is replaced", () => {
    const { buffer, frames } = createBuffer();
    const original = "The answer starts with a shared opening and then diverges.";
    buffer.visibleText({ key: "live", runId: "run-1", text: original, streaming: true });
    frames.advance(3);
    const painted = buffer.visibleText({
      key: "live",
      runId: "run-1",
      text: original,
      streaming: true,
    });
    const replacement = "The answer starts with a shared opening and then finishes.";
    const next = buffer.visibleText({
      key: "live",
      runId: "run-1",
      text: replacement,
      streaming: true,
    });
    expect(next.text.length).toBeGreaterThan(0);
    expect(next.text.length).toBeLessThanOrEqual(painted.text.length);
    expect(replacement.startsWith(next.text)).toBe(true);
    frames.advance(200);
    expect(buffer.visibleText({ key: "live", runId: "run-1", text: replacement }).text).toBe(
      replacement,
    );
  });

  it("cancels the previous session's reveal and stops scheduling frames", () => {
    const { buffer, frames, scheduleUpdate } = createBuffer();
    buffer.visibleText({ key: "live", runId: "run-1", text: REPLY, streaming: true });
    expect(frames.pendingFrames).toBe(1);

    buffer.beginPass({
      sessionKey: "agent:other:main",
      runId: null,
      live: false,
      historySettled: true,
      scheduleUpdate,
    });
    expect(frames.pendingFrames).toBe(0);
    scheduleUpdate.mockClear();
    frames.advance(10);
    expect(scheduleUpdate).not.toHaveBeenCalled();
    expect(
      buffer.visibleText({ key: "live", runId: "run-1", text: REPLY, streaming: true }),
    ).toEqual({ text: REPLY, revealing: false });
  });

  it("advances version only for the run whose rows repaint", () => {
    const { buffer, frames } = createBuffer();
    expect(buffer.versionForRun("run-1")).toBe(0);
    buffer.visibleText({ key: "live", runId: "run-1", text: REPLY, streaming: true });
    const created = buffer.versionForRun("run-1");
    expect(created).toBeGreaterThan(0);
    frames.advance();
    const advanced = buffer.versionForRun("run-1");
    expect(advanced).toBeGreaterThan(created);
    expect(buffer.versionForRun("run-other")).toBe(0);
    frames.advance(400);
    buffer.visibleText({ key: "live", runId: "run-1", text: REPLY, streaming: false });
    expect(buffer.versionForRun("run-1")).toBe(0);
  });

  it.each([
    { label: "surrogate pair", text: "A family 👍🏽 emoji reply that keeps arriving" },
    { label: "ZWJ family", text: "A family 👨‍👩‍👧‍👦 emoji reply that keeps arriving" },
    { label: "combining marks", text: "Combining e\u0301 and a\u0308 marks keep arriving here" },
    { label: "CRLF lines", text: "First line\r\nSecond line\r\nThird line keeps arriving" },
    { label: "emphasis run", text: "Some **strong emphasis** and `code` keep arriving" },
  ])("cuts only at Unicode/Markdown-safe boundaries for $label", ({ text }) => {
    const { buffer, frames } = createBuffer();
    let painted = buffer.visibleText({ key: "live", runId: "run-1", text, streaming: true });
    for (let frame = 0; frame < 400 && painted.revealing; frame += 1) {
      expect(text.startsWith(painted.text)).toBe(true);
      expect(snapRevealIndex(text, painted.text.length)).toBe(painted.text.length);
      const trailing = painted.text.charCodeAt(painted.text.length - 1);
      expect(trailing >= 0xd800 && trailing <= 0xdbff).toBe(false);
      expect(painted.text.endsWith("\\")).toBe(false);
      frames.advance();
      painted = buffer.visibleText({ key: "live", runId: "run-1", text, streaming: true });
    }
    expect(painted.text).toBe(text);
  });

  it("snaps a cut out of marker runs, escapes, and joined glyphs", () => {
    expect(snapRevealIndex("*emphasis* text", 1)).toBe(1);
    expect(snapRevealIndex("**emphasis** text", 1)).toBe(2);
    expect(snapRevealIndex("a \\*star", 3)).toBe(4);
    expect(snapRevealIndex("e\u0301clair", 1)).toBe(2);
    expect(snapRevealIndex("emoji 👍🏽 tail", 7)).toBe(10);
    expect(snapRevealIndex("line\r\nnext", 4)).toBe(4);
    expect(snapRevealIndex("line\r\nnext", 5)).toBe(6);
    expect(snapRevealIndex("short", 99)).toBe(5);
    expect(snapRevealIndex("short", -3)).toBe(0);
  });
});
