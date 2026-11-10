/**
 * Presentation-only smooth reveal for assistant text.
 *
 * Canonical content, transcript bytes, session persistence, and tool execution
 * stay with their owners. This buffer only decides how much of an already
 * arrived string is painted on this frame, so a 20/40/40 delta burst, a paused
 * pause waiting for more text, and a one-shot final answer share one queue:
 * reveal pauses when caught up, continues when later chunks arrive, and drains
 * the complete final text before the row settles into document mode.
 */

import { normalizeRoleForGrouping } from "../../../lib/chat/message-normalizer.ts";

export type ChatRevealFrameClock = {
  now: () => number;
  requestFrame: (callback: () => void) => number;
  cancelFrame: (handle: number) => void;
};

export type ChatRevealRequest = {
  /** Transcript row key; carries the painted text across stream/final handoff. */
  key: string;
  text: string;
  runId?: string | null;
  streaming?: boolean;
  /**
   * The row belongs to the pane's current run even without its own run id
   * (unowned stream parts, the settled final answer).
   */
  liveTail?: boolean;
  /** Settled history, search results, and media-interleaved bodies paint at once. */
  instant?: boolean;
};

export type ChatRevealText = {
  text: string;
  revealing: boolean;
};

/**
 * Reveal policy for assistant message bodies: stream parts and the settled
 * final answer animate, while other roles, search results, expanded full-message
 * disclosures, and media-interleaved bodies paint settled text.
 */
export function revealAssistantText(
  reveal: ChatRevealBuffer | undefined,
  request: ChatRevealRequest & { role?: string; searchResult?: boolean },
): ChatRevealText | undefined {
  if (
    !reveal ||
    request.searchResult ||
    normalizeRoleForGrouping(request.role ?? "") !== "assistant"
  ) {
    return undefined;
  }
  return reveal.visibleText(request);
}

export type ChatRevealRow = {
  readonly key?: string;
  readonly runId?: string;
  readonly groups?: readonly { readonly runId?: string }[];
};

/** Structural owner of the pane's final answer row (a group or the wrapping frame). */
export type ChatRevealTailOwner = {
  readonly kind?: string;
  readonly key?: string;
  readonly parts?: readonly ChatRevealTailOwner[];
  readonly groups?: readonly { readonly key: string }[];
};

function revealOwnerGroupKeys(owner: ChatRevealTailOwner | null): string[] {
  if (!owner?.key) {
    return [];
  }
  if (owner.kind === "group") {
    return [owner.key];
  }
  const keys: string[] = [];
  for (const part of owner.parts ?? []) {
    keys.push(...revealOwnerGroupKeys(part));
    for (const group of part.groups ?? []) {
      keys.push(group.key);
    }
  }
  return keys;
}

type RevealEntry = {
  /** Buffer-local identity (`runKey\0rowKey`); the row keeps its own key too. */
  entryKey: string;
  runKey: string;
  key: string;
  text: string;
  revealed: number;
  streaming: boolean;
  version: number;
};

type RunObservation = {
  /** Projection pass that first saw this run live. */
  firstPass: number;
  armed: boolean;
  entries: number;
};

// A readable cadence for one short line; a growing backlog drains against a
// sub-second time constant instead of queueing whole paragraphs, and the
// per-frame cap keeps a single step from pasting several lines at once.
const BASE_CHARS_PER_SECOND = 48;
const DRAIN_TAU_MS = 520;
const MAX_CHARS_PER_FRAME = 72;
const MAX_FRAME_MS = 48;
const MAX_ENTRIES = 8;
const MAX_COMPLETED_KEYS = 128;
const MAX_RUN_OBSERVATIONS = 24;
const MIN_HANDOFF_PREFIX_CHARS = 4;
const MAX_PANE_BUFFERS = 8;

const ZERO_WIDTH_JOINER = 0x200d;
const COMBINING_MARK_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0300, 0x036f],
  [0x0483, 0x0489],
  [0x0591, 0x05bd],
  [0x0610, 0x061a],
  [0x064b, 0x065f],
  [0x0670, 0x0670],
  [0x06d6, 0x06dc],
  [0x0900, 0x0902],
  [0x093a, 0x093a],
  [0x093c, 0x093c],
  [0x0941, 0x0948],
  [0x094d, 0x094d],
  [0x0e31, 0x0e31],
  [0x0e34, 0x0e3a],
  [0x0e47, 0x0e4e],
  [0x1ab0, 0x1aff],
  [0x1dc0, 0x1dff],
  [0x20d0, 0x20ff],
  [0xfe00, 0xfe0f],
  [0xfe20, 0xfe2f],
  [0x1f3fb, 0x1f3ff],
  [0xe0100, 0xe01ef],
];
// Runs of Markdown emphasis/code/escape markers stay whole so a reveal step
// never paints a lone `*` or backslash before its partner arrives.
const MARKDOWN_MARKER_CODEPOINTS = new Set([0x60, 0x2a, 0x5f, 0x7e, 0x5c]);

function isCombiningMark(codePoint: number): boolean {
  return COMBINING_MARK_RANGES.some(([from, to]) => codePoint >= from && codePoint <= to);
}

function codePointBefore(text: string, index: number): number | null {
  if (index <= 0) {
    return null;
  }
  const trailing = text.charCodeAt(index - 1);
  if (trailing >= 0xdc00 && trailing <= 0xdfff && index >= 2) {
    const leading = text.charCodeAt(index - 2);
    if (leading >= 0xd800 && leading <= 0xdbff) {
      return text.codePointAt(index - 2) ?? null;
    }
  }
  return trailing;
}

/**
 * Move a candidate cut forward until it cannot split a surrogate pair, a
 * grapheme cluster, a ZWJ emoji sequence, a CRLF pair, or a Markdown marker run.
 */
export function snapRevealIndex(text: string, index: number): number {
  if (index <= 0) {
    return 0;
  }
  let cut = Math.min(index, text.length);
  const trailing = cut < text.length ? text.charCodeAt(cut) : -1;
  if (trailing >= 0xdc00 && trailing <= 0xdfff) {
    cut += 1;
  }
  // An escape marker owns the character it escapes.
  const marker = codePointBefore(text, cut);
  if (marker !== null && MARKDOWN_MARKER_CODEPOINTS.has(marker)) {
    while (cut < text.length && text.charCodeAt(cut) === marker) {
      cut += 1;
    }
    if (marker === 0x5c && cut < text.length && text.charCodeAt(cut) !== 0x0a) {
      cut += text.codePointAt(cut)! > 0xffff ? 2 : 1;
    }
  }
  for (;;) {
    if (cut >= text.length) {
      return text.length;
    }
    const next = text.codePointAt(cut)!;
    const previous = codePointBefore(text, cut);
    if (previous === ZERO_WIDTH_JOINER || isCombiningMark(next)) {
      cut += next > 0xffff ? 2 : 1;
      continue;
    }
    break;
  }
  if (text.charCodeAt(cut - 1) === 0x0d && text.charCodeAt(cut) === 0x0a) {
    cut += 1;
  }
  return cut;
}

function commonPrefixLength(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let index = 0;
  while (index < limit && a.charCodeAt(index) === b.charCodeAt(index)) {
    index += 1;
  }
  return index;
}

/** First visible glyph offset, so a reveal start never paints a blank row. */
function revealStartIndex(text: string): number {
  let start = 0;
  while (start < text.length && /\s/u.test(text.charAt(start))) {
    start += 1;
  }
  return start >= text.length ? text.length : snapRevealIndex(text, start + 1);
}

function revealStep(remaining: number, deltaMs: number): number {
  const base = (deltaMs / 1_000) * BASE_CHARS_PER_SECOND;
  const paced = remaining * (deltaMs / DRAIN_TAU_MS);
  return Math.min(MAX_CHARS_PER_FRAME, Math.max(1, Math.round(base + paced)));
}

function defaultRevealFrameClock(): ChatRevealFrameClock {
  const request = globalThis.requestAnimationFrame?.bind(globalThis);
  const cancel = globalThis.cancelAnimationFrame?.bind(globalThis);
  return {
    now: () => globalThis.performance?.now?.() ?? Date.now(),
    requestFrame:
      request ?? ((callback) => globalThis.setTimeout(callback, 16) as unknown as number),
    cancelFrame: cancel ?? ((handle) => globalThis.clearTimeout(handle)),
  };
}

export class ChatRevealBuffer {
  private readonly clock: ChatRevealFrameClock;
  private readonly reducedMotion: () => boolean;
  private readonly entries = new Map<string, RevealEntry>();
  private readonly completed = new Set<string>();
  private readonly runs = new Map<string, RunObservation>();
  private readonly tailKeys = new Set<string>();
  private sessionKey: string | null = null;
  private liveRunId: string | null = null;
  private scheduleUpdate: () => void = () => {};
  private frame: number | null = null;
  private lastFrameAt = 0;
  private pass = 0;
  private version = 0;
  private motionQuery: MediaQueryList | null | undefined;

  constructor(options: { clock?: ChatRevealFrameClock; reducedMotion?: () => boolean } = {}) {
    this.clock = options.clock ?? defaultRevealFrameClock();
    this.reducedMotion = options.reducedMotion ?? (() => this.motionQueryMatches());
  }

  /**
   * One call per transcript projection. Session switches drop buffered runs,
   * and a settled history load arms the live run so only text that arrives
   * after the pane attached animates; a replay during initial load paints.
   */
  beginPass(pass: {
    sessionKey: string;
    runId?: string | null;
    live: boolean;
    historySettled: boolean;
    scheduleUpdate: () => void;
  }): void {
    if (this.sessionKey !== pass.sessionKey) {
      this.reset();
      this.sessionKey = pass.sessionKey;
    }
    this.pass += 1;
    this.scheduleUpdate = pass.scheduleUpdate;
    this.liveRunId = pass.runId ?? this.liveRunId;
    if (!pass.live || !pass.runId) {
      return;
    }
    const observation = this.runs.get(pass.runId) ?? {
      firstPass: this.pass,
      armed: false,
      entries: 0,
    };
    // A run observed live in an earlier pass is producing new output; the same
    // pass that first sees a run is its attached history and must not animate.
    if (pass.historySettled && observation.firstPass < this.pass) {
      observation.armed = true;
    }
    this.runs.delete(pass.runId);
    this.runs.set(pass.runId, observation);
    this.pruneRuns();
  }

  versionForRun(runId?: string | null): number {
    const runKey = this.resolveRunKey(runId, true);
    let version = 0;
    for (const entry of this.entries.values()) {
      if (entry.runKey === runKey) {
        version = Math.max(version, entry.version);
      }
    }
    return version;
  }

  /** Row-guard dependency for any transcript row that may be revealing. */
  versionForRow(row: ChatRevealRow): number {
    return row.groups
      ? Math.max(0, ...row.groups.map((group) => this.versionForRun(group.runId)))
      : this.versionForRun(row.runId);
  }

  /**
   * The pane's settled final answer is the only identity-less row that may
   * animate; returns its key so the caller can keep one owner for both facts.
   */
  focusTail(owner: ChatRevealTailOwner | null): string | null {
    // A null owner keeps the previous tail: an answer that is still revealing
    // must not jump while the next run is starting. New tails replace the set.
    if (owner) {
      this.tailKeys.clear();
      for (const key of revealOwnerGroupKeys(owner)) {
        this.tailKeys.add(key);
      }
    }
    return owner?.key ?? null;
  }

  isTail(rowKey: string): boolean {
    return this.tailKeys.has(rowKey);
  }

  /** Visible prefix for one row; the canonical text itself is never rewritten. */
  visibleText(request: ChatRevealRequest): ChatRevealText {
    const text = request.text;
    if (!text) {
      return { text, revealing: false };
    }
    const runKey = this.resolveRunKey(request.runId, request.liveTail === true);
    const observation = this.runs.get(runKey);
    // History rows and other runs never animate, so their renders stay free of
    // buffer bookkeeping even with hundreds of visible messages.
    if (!observation) {
      return { text, revealing: false };
    }
    const entryKey = `${runKey}\u0000${request.key}`;
    const existing = this.entries.get(entryKey);
    if (request.instant === true || this.reducedMotion()) {
      this.complete(entryKey);
      return { text, revealing: false };
    }
    if (existing) {
      return this.advanceTarget(existing, request);
    }
    if (this.completed.has(entryKey)) {
      return { text, revealing: false };
    }
    const inherited = this.inheritReveal(runKey, text);
    if (inherited !== null) {
      return this.startEntry(runKey, entryKey, request, inherited);
    }
    if (!observation.armed) {
      // Attached to a run that was already producing text: paint its backlog
      // and animate only what arrives afterwards.
      return this.startEntry(runKey, entryKey, request, text.length);
    }
    return this.startEntry(runKey, entryKey, request, 0);
  }

  dispose(): void {
    this.reset();
    this.sessionKey = null;
  }

  private motionQueryMatches(): boolean {
    if (this.motionQuery === undefined) {
      this.motionQuery =
        typeof globalThis.matchMedia === "function"
          ? globalThis.matchMedia("(prefers-reduced-motion: reduce)")
          : null;
    }
    // A host without a media-query implementation cannot report a motion
    // preference, so it paints settled text instead of animating on a guess.
    return this.motionQuery === null || this.motionQuery.matches;
  }

  private resolveRunKey(runId: string | null | undefined, liveTail: boolean): string {
    // A row without its own run id animates only when the projection marks it
    // as the pane's live tail; a missing identity is otherwise history.
    return runId ?? (liveTail ? this.liveRunId : null) ?? "";
  }

  private startEntry(
    runKey: string,
    entryKey: string,
    request: ChatRevealRequest,
    revealed: number,
  ): ChatRevealText {
    const text = request.text;
    const entry: RevealEntry = {
      entryKey,
      runKey,
      key: request.key,
      text,
      revealed: revealed > 0 ? Math.min(revealed, text.length) : revealStartIndex(text),
      streaming: request.streaming === true,
      version: ++this.version,
    };
    this.entries.set(entryKey, entry);
    const observation = this.runs.get(runKey);
    if (observation) {
      observation.entries += 1;
    }
    this.pruneEntries();
    if (entry.revealed >= text.length) {
      return { text, revealing: false };
    }
    this.startFrames();
    return { text: text.slice(0, entry.revealed), revealing: true };
  }

  private advanceTarget(entry: RevealEntry, request: ChatRevealRequest): ChatRevealText {
    entry.streaming = request.streaming === true;
    if (entry.text !== request.text) {
      const painted = entry.text.slice(0, entry.revealed);
      entry.text = request.text;
      // Keep every already painted character that the new canonical text still
      // contains; the row may swap identity (stream segment -> final message).
      entry.revealed = Math.min(entry.revealed, commonPrefixLength(painted, request.text));
    }
    if (entry.revealed === 0) {
      // A divergent replacement must still paint one visible glyph, never an
      // empty row that the bubble would suppress.
      entry.revealed = revealStartIndex(entry.text);
    }
    if (entry.revealed >= entry.text.length) {
      entry.revealed = entry.text.length;
      entry.version = ++this.version;
      if (!entry.streaming) {
        this.complete(entry.entryKey);
      }
      return { text: entry.text, revealing: false };
    }
    this.startFrames();
    return { text: entry.text.slice(0, entry.revealed), revealing: true };
  }

  /**
   * Adopt the reveal position of an already painted row of the same run. The
   * live stream part and the settled final message use different row keys, so
   * without this handoff the final answer would restart or jump.
   */
  private inheritReveal(runKey: string, text: string): number | null {
    const candidates = [...this.entries.values()].filter((entry) => entry.runKey === runKey);
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const candidate = candidates[index]!;
      const painted = candidate.text.slice(0, candidate.revealed);
      if (!painted) {
        continue;
      }
      if (text.startsWith(painted)) {
        this.complete(candidate.entryKey);
        return candidate.revealed;
      }
      const prefix = commonPrefixLength(painted, text);
      if (prefix >= Math.min(MIN_HANDOFF_PREFIX_CHARS, painted.length)) {
        this.complete(candidate.entryKey);
        return prefix;
      }
    }
    return null;
  }

  private complete(entryKey: string): void {
    const entry = this.entries.get(entryKey);
    if (!entry) {
      return;
    }
    this.entries.delete(entryKey);
    const observation = this.runs.get(entry.runKey);
    if (observation) {
      observation.entries = Math.max(0, observation.entries - 1);
    }
    this.completed.delete(entryKey);
    this.completed.add(entryKey);
    if (this.completed.size > MAX_COMPLETED_KEYS) {
      const oldest = this.completed.values().next().value;
      if (oldest !== undefined) {
        this.completed.delete(oldest);
      }
    }
  }

  private startFrames(): void {
    if (this.frame !== null) {
      return;
    }
    this.lastFrameAt = this.clock.now();
    this.frame = this.clock.requestFrame(this.tick);
  }

  private readonly tick = (): void => {
    this.frame = null;
    const now = this.clock.now();
    const deltaMs = Math.max(0, Math.min(now - this.lastFrameAt, MAX_FRAME_MS));
    this.lastFrameAt = now;
    let advanced = false;
    for (const entry of this.entries.values()) {
      if (entry.revealed >= entry.text.length) {
        continue;
      }
      const remaining = entry.text.length - entry.revealed;
      const next = snapRevealIndex(entry.text, entry.revealed + revealStep(remaining, deltaMs));
      if (next <= entry.revealed) {
        continue;
      }
      entry.revealed = Math.min(next, entry.text.length);
      entry.version = ++this.version;
      advanced = true;
    }
    if (advanced) {
      this.scheduleUpdate();
    }
    if (this.hasRemaining()) {
      this.frame = this.clock.requestFrame(this.tick);
    }
  };

  private hasRemaining(): boolean {
    for (const entry of this.entries.values()) {
      if (entry.revealed < entry.text.length) {
        return true;
      }
    }
    return false;
  }

  private pruneEntries(): void {
    if (this.entries.size <= MAX_ENTRIES) {
      return;
    }
    for (const [entryKey, entry] of this.entries) {
      if (this.entries.size <= MAX_ENTRIES) {
        return;
      }
      const settled = entry.revealed >= entry.text.length && !entry.streaming;
      if (settled || this.entries.size > MAX_ENTRIES) {
        this.complete(entryKey);
      }
    }
  }

  private pruneRuns(): void {
    if (this.runs.size <= MAX_RUN_OBSERVATIONS) {
      return;
    }
    for (const [runId, observation] of this.runs) {
      if (this.runs.size <= MAX_RUN_OBSERVATIONS) {
        return;
      }
      if (observation.entries === 0 && runId !== this.liveRunId) {
        this.runs.delete(runId);
      }
    }
  }

  private reset(): void {
    if (this.frame !== null) {
      this.clock.cancelFrame(this.frame);
      this.frame = null;
    }
    this.entries.clear();
    this.completed.clear();
    this.runs.clear();
    this.tailKeys.clear();
    this.liveRunId = null;
    this.scheduleUpdate = () => {};
  }
}

const paneBuffers = new Map<string, ChatRevealBuffer>();

/** One buffer per chat pane: session switches and split view stay isolated. */
export function chatRevealBufferForPane(paneId: string): ChatRevealBuffer {
  let buffer = paneBuffers.get(paneId);
  if (!buffer) {
    buffer = new ChatRevealBuffer();
    if (paneBuffers.size >= MAX_PANE_BUFFERS) {
      const oldest = paneBuffers.keys().next().value;
      if (oldest !== undefined) {
        paneBuffers.get(oldest)?.dispose();
        paneBuffers.delete(oldest);
      }
    }
  }
  paneBuffers.delete(paneId);
  paneBuffers.set(paneId, buffer);
  return buffer;
}

/** Transcript-projection entry: scope the pane's reveal to its session and run. */
export function beginChatReveal(
  props: {
    paneId: string;
    sessionKey: string;
    runId?: string | null;
    runActive?: boolean;
    runWorking?: boolean;
    stream?: string | null;
    loading?: boolean;
  },
  scheduleUpdate: () => void,
): ChatRevealBuffer {
  const buffer = chatRevealBufferForPane(props.paneId);
  buffer.beginPass({
    sessionKey: props.sessionKey,
    runId: props.runId ?? null,
    live:
      Boolean(props.runId || props.runActive || props.runWorking) ||
      (props.stream ?? null) !== null,
    historySettled: !props.loading,
    scheduleUpdate,
  });
  return buffer;
}
