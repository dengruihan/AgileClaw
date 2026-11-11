/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import { groupMessages } from "../chat-thread-grouping.ts";
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
    buffer.noteLiveStream("run-1", "stream-row");
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
    buffer.focusTail(
      { kind: "group", key: "group:assistant:message-row", role: "assistant", messages: [] },
      "run-1",
    );
    const handedOff = buffer.visibleText({
      key: "message-row",
      runId: "run-1",
      text: finalText,
      streaming: false,
      liveTail: true,
    });
    expect(handedOff.revealing).toBe(true);
    expect(handedOff.text).toBe(painted.text);
    // The source row keeps its own reveal; the handoff never completes or
    // retracts the row it continued from.
    expect(buffer.visibleText({ key: "stream-row", runId: "run-1", text: streamText })).toEqual({
      text: painted.text,
      revealing: true,
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

function createFrameClockWithEpoch() {
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

function createLifecycleBuffer() {
  const frames = createFrameClockWithEpoch();
  const scheduleUpdate = vi.fn();
  const buffer = new ChatRevealBuffer({
    clock: frames.clock,
    reducedMotion: () => false,
  });
  buffer.beginPass({
    sessionKey: "agent:main:main",
    connectionEpoch: 1,
    runId: "run-1",
    live: true,
    historySettled: true,
    scheduleUpdate: () => {},
  });
  buffer.beginPass({
    sessionKey: "agent:main:main",
    connectionEpoch: 1,
    runId: "run-1",
    live: true,
    historySettled: true,
    scheduleUpdate,
  });
  return { buffer, frames, scheduleUpdate };
}

const LONG_REPLY = `Shared prefix: alpha ${"keeps growing with readable pacing. ".repeat(4)}`;
const OTHER_REPLY = `Shared prefix: beta ${"is a separate same-run row. ".repeat(4)}`;

describe("chat reveal ownership regressions", () => {
  it("continues from the bound live-stream entry even when a newer same-run row shares the opening", () => {
    const { buffer, frames } = createLifecycleBuffer();
    // The projection notes the run's live stream row while it streams.
    buffer.noteLiveStream("run-1", "stream-a");
    buffer.visibleText({ key: "stream-a", runId: "run-1", text: LONG_REPLY, streaming: true });
    frames.advance(3);
    const paintedA = buffer.visibleText({
      key: "stream-a",
      runId: "run-1",
      text: LONG_REPLY,
      streaming: true,
    });
    expect(paintedA.revealing).toBe(true);
    expect(paintedA.text.length).toBeGreaterThan(10);
    // A newer same-run row renders later and shares only the opening.
    const paintedB = buffer.visibleText({
      key: "stream-b",
      runId: "run-1",
      text: OTHER_REPLY,
      streaming: true,
    });
    expect(paintedB.revealing).toBe(true);
    expect(paintedB.text.length).toBeLessThan(paintedA.text.length);

    buffer.focusTail(
      { kind: "group", key: "group:assistant:final-a", role: "assistant", messages: [] },
      "run-1",
    );
    const finalText = `${LONG_REPLY} and finishes.`;
    const finalA = buffer.visibleText({
      key: "final-a",
      runId: "run-1",
      text: finalText,
      streaming: false,
      liveTail: true,
    });
    // Exact A-before/A-after continuity: no retraction to B's short prefix.
    expect(finalA.text).toBe(paintedA.text);
    // B keeps its own reveal: not retracted, not completed by A's final.
    expect(
      buffer.visibleText({
        key: "stream-b",
        runId: "run-1",
        text: OTHER_REPLY,
        streaming: true,
      }),
    ).toEqual({ text: paintedB.text, revealing: true });
    frames.advance(400);
    expect(
      buffer.visibleText({ key: "final-a", runId: "run-1", text: finalText, streaming: false }),
    ).toEqual({ text: finalText, revealing: false });
  });

  it("paints settled instead of adopting or restarting when no bound predecessor exists", () => {
    const { buffer, frames } = createLifecycleBuffer();
    buffer.visibleText({ key: "stream-a", runId: "run-1", text: LONG_REPLY, streaming: true });
    frames.advance(2);
    // The tail is focused without a live-stream binding (e.g. restored state).
    buffer.focusTail(
      { kind: "group", key: "group:assistant:final-a", role: "assistant", messages: [] },
      "run-1",
    );
    expect(
      buffer.visibleText({
        key: "final-a",
        runId: "run-1",
        text: `${LONG_REPLY} and finishes.`,
        streaming: false,
        liveTail: true,
      }),
    ).toEqual({ text: `${LONG_REPLY} and finishes.`, revealing: false });
  });

  it("focuses only the action owner's rendered group, not every group in the tail frame", () => {
    const commentary = groupMessages([
      { kind: "message", key: "assistant:0", message: { role: "assistant", content: "Checking." } },
    ])[0] as MessageGroup;
    const answer = groupMessages([
      {
        kind: "message",
        key: "assistant:1",
        message: { role: "assistant", content: LONG_REPLY },
      },
    ])[0] as MessageGroup;
    expect(answer.key).toBe("group:assistant:assistant:1");
    const { buffer } = createLifecycleBuffer();
    buffer.focusTail({
      kind: "agent-run-frame",
      key: "answer-frame",
      parts: [commentary, answer],
      outcome: { kind: "completed", actionOwner: answer.messages[0] },
    });
    expect(buffer.isTail(answer.key)).toBe(true);
    expect(buffer.isTail(commentary.key)).toBe(false);

    const revealed = buffer.visibleText({
      key: answer.key,
      text: LONG_REPLY,
      streaming: false,
      liveTail: buffer.isTail(answer.key),
    });
    expect(revealed.revealing).toBe(true);
    expect(revealed.text.length).toBeGreaterThan(0);
    expect(revealed.text.length).toBeLessThan(LONG_REPLY.length);
  });

  it("cancels same-session work on a connection transition and supersedes an explicit new run", () => {
    const { buffer, frames, scheduleUpdate } = createLifecycleBuffer();
    buffer.visibleText({ key: "stream-a", runId: "run-1", text: LONG_REPLY, streaming: true });
    expect(frames.pendingFrames).toBe(1);
    const run1Version = buffer.versionForRun("run-1");
    expect(run1Version).toBeGreaterThan(0);

    // Same session, new connection epoch: the previous frame and versions retire.
    buffer.beginPass({
      sessionKey: "agent:main:main",
      connectionEpoch: 2,
      runId: null,
      live: false,
      historySettled: true,
      scheduleUpdate,
    });
    expect(frames.pendingFrames).toBe(0);
    expect(buffer.versionForRun("run-1")).toBe(0);
    scheduleUpdate.mockClear();
    frames.advance(5);
    expect(scheduleUpdate).not.toHaveBeenCalled();

    // A new run in the same epoch also retires the previous run's work.
    for (const pass of [0, 1]) {
      buffer.beginPass({
        sessionKey: "agent:main:main",
        connectionEpoch: 2,
        runId: "run-2",
        live: true,
        historySettled: true,
        scheduleUpdate: pass === 0 ? () => {} : scheduleUpdate,
      });
    }
    buffer.visibleText({ key: "stream-b", runId: "run-2", text: OTHER_REPLY, streaming: true });
    expect(frames.pendingFrames).toBe(1);
    buffer.beginPass({
      sessionKey: "agent:main:main",
      connectionEpoch: 2,
      runId: "run-3",
      live: true,
      historySettled: true,
      scheduleUpdate,
    });
    expect(frames.pendingFrames).toBe(0);
    expect(buffer.versionForRun("run-2")).toBe(0);
  });

  it("does not animate a stale identity-less tail under a later run", () => {
    const { buffer } = createLifecycleBuffer();
    const staleTail = "Earlier completed answer that must paint settled.";
    buffer.focusTail({
      kind: "group",
      key: "group:assistant:old",
      role: "assistant",
      messages: [],
    });
    for (const pass of [0, 1]) {
      buffer.beginPass({
        sessionKey: "agent:main:main",
        connectionEpoch: 1,
        runId: "run-2",
        live: true,
        historySettled: true,
        scheduleUpdate: pass === 0 ? () => {} : () => {},
      });
    }
    expect(
      buffer.visibleText({
        key: "group:assistant:old",
        text: staleTail,
        streaming: false,
        liveTail: buffer.isTail("group:assistant:old"),
      }),
    ).toEqual({ text: staleTail, revealing: false });
  });

  it("keeps an intentional settled-final drain alive across idle passes", () => {
    const { buffer, frames, scheduleUpdate } = createLifecycleBuffer();
    buffer.noteLiveStream("run-1", "stream-a");
    buffer.visibleText({ key: "stream-a", runId: "run-1", text: LONG_REPLY, streaming: true });
    const painted = buffer.visibleText({
      key: "stream-a",
      runId: "run-1",
      text: LONG_REPLY,
      streaming: true,
    });
    // The run settles; the final action owner continues from the painted text.
    const finalText = `${LONG_REPLY} and finishes.`;
    buffer.focusTail(
      { kind: "group", key: "group:assistant:final-a", role: "assistant", messages: [] },
      "run-1",
    );
    buffer.beginPass({
      sessionKey: "agent:main:main",
      connectionEpoch: 1,
      runId: "run-1",
      live: false,
      historySettled: true,
      scheduleUpdate,
    });
    const final = buffer.visibleText({
      key: "final-a",
      runId: "run-1",
      text: finalText,
      streaming: false,
      liveTail: true,
    });
    expect(final.text).toBe(painted.text);

    // The pane's run id can clear while the final still drains; that is not a
    // disconnect and must not cancel the drain.
    buffer.beginPass({
      sessionKey: "agent:main:main",
      connectionEpoch: 1,
      runId: null,
      live: false,
      historySettled: true,
      scheduleUpdate,
    });
    expect(frames.pendingFrames).toBe(1);
    const before = buffer.visibleText({
      key: "final-a",
      runId: "run-1",
      text: finalText,
      streaming: false,
      liveTail: true,
    });
    frames.advance(2);
    const after = buffer.visibleText({
      key: "final-a",
      runId: "run-1",
      text: finalText,
      streaming: false,
      liveTail: true,
    });
    expect(after.text.length).toBeGreaterThan(before.text.length);
  });

  it.each([
    { label: "flag regional indicators", text: "🇨🇳🇯🇵 flags stay whole in the reveal" },
    { label: "ZWJ family", text: "👨‍👩‍👧‍👦 families stay whole in the reveal" },
    { label: "keycap", text: "1️⃣ keycaps stay whole in the reveal" },
    { label: "combining marks", text: "e\u0301clair combining marks stay whole" },
    { label: "emoji modifier", text: "👍🏽 thumbs stay whole in the reveal" },
  ])("cuts only at independent grapheme boundaries: $label", ({ text }) => {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    const boundaries = new Set<number>();
    for (const { index, segment } of segmenter.segment(text)) {
      boundaries.add(index);
      boundaries.add(index + segment.length);
    }
    const { buffer, frames } = createLifecycleBuffer();
    let painted = buffer.visibleText({ key: "grapheme", runId: "run-1", text, streaming: true });
    for (let frame = 0; frame < 400 && painted.revealing; frame += 1) {
      expect(boundaries.has(painted.text.length)).toBe(true);
      expect(text.startsWith(painted.text)).toBe(true);
      frames.advance();
      painted = buffer.visibleText({
        key: "grapheme",
        runId: "run-1",
        text,
        streaming: true,
      });
    }
    expect(painted.text).toBe(text);
  });

  const segmenterBoundaries = (text: string): Set<number> => {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    const boundaries = new Set<number>();
    for (const segment of segmenter.segment(text)) {
      boundaries.add(segment.index);
      boundaries.add(segment.index + segment.segment.length);
    }
    return boundaries;
  };

  it.each([
    { label: "flag", text: "a\\🇨🇳 tail" },
    { label: "ZWJ family", text: "a\\👨‍👩‍👧‍👦 tail" },
    { label: "keycap", text: "a\\1️⃣ tail" },
    { label: "combining marks", text: "a\\e\u0301 tail" },
    { label: "emoji modifier", text: "a\\👍🏽 tail" },
  ])("keeps an escaped grapheme whole through the frame scheduler: $label", ({ text }) => {
    const boundaries = segmenterBoundaries(text);
    const { buffer, frames } = createLifecycleBuffer();
    const painted: string[] = [];
    let frame = buffer.visibleText({ key: "escaped", runId: "run-1", text, streaming: true });
    for (let step = 0; step < 200 && frame.revealing; step += 1) {
      expect(boundaries.has(frame.text.length)).toBe(true);
      expect(text.startsWith(frame.text)).toBe(true);
      painted.push(frame.text);
      frames.advance();
      frame = buffer.visibleText({ key: "escaped", runId: "run-1", text, streaming: true });
    }
    expect(frame.text).toBe(text);
    // The escaped cluster is painted whole, never split by the backslash step.
    const escaped = text.slice(2);
    const firstWithEscapedChar = painted.find((value) => value.length >= 2);
    expect(firstWithEscapedChar).toBeDefined();
    const clusters = new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(escaped);
    const firstCluster = clusters[Symbol.iterator]().next().value as Intl.SegmentData;
    expect(painted.some((value) => value === `a\\${firstCluster.segment}`)).toBe(true);
  });

  it.each([
    { label: "bold emphasis", text: "**bold** and 🇨🇳 flag" },
    { label: "heading", text: "# Heading with 👨‍👩‍👧‍👦" },
    { label: "list with escape", text: "- item one\\* escaped 1️⃣" },
    { label: "quote", text: "> quote with e\u0301clair" },
    { label: "code fence", text: "```ts\nconst x = 1;\n```" },
  ])("keeps the initial Markdown prefix reveal grapheme-safe: $label", ({ text }) => {
    const boundaries = segmenterBoundaries(text);
    const { buffer, frames } = createLifecycleBuffer();
    let frame = buffer.visibleText({ key: `md-${text}`, runId: "run-1", text, streaming: true });
    const lengths: number[] = [];
    for (let step = 0; step < 300 && frame.revealing; step += 1) {
      expect(boundaries.has(frame.text.length)).toBe(true);
      lengths.push(frame.text.length);
      frames.advance();
      frame = buffer.visibleText({ key: `md-${text}`, runId: "run-1", text, streaming: true });
    }
    expect(frame.text).toBe(text);
    expect(lengths[0]).toBeGreaterThan(0);
    expect(lengths.toSorted((a, b) => a - b)).toEqual(lengths);
  });

  it("includes the whole first grapheme cluster on the first frame", () => {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    for (const text of ["🇨🇳 flag", "👨‍👩‍👧‍👦 family", "e\u0301clair", "1️⃣ keycap"]) {
      const first = segmenter.segment(text)[Symbol.iterator]().next().value as
        | Intl.SegmentData
        | undefined;
      const { buffer } = createLifecycleBuffer();
      const painted = buffer.visibleText({ key: "first", runId: "run-1", text, streaming: true });
      expect(painted.text).toBe(first?.segment ?? "");
    }
  });
});
