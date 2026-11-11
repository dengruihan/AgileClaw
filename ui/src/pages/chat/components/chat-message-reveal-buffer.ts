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

import {
  containingSegment,
  firstGraphemeClusterLength,
  skipWhitespaceGraphemes,
} from "@openclaw/normalization-core/grapheme";
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
  readonly role?: string;
  readonly messages?: readonly unknown[];
  readonly parts?: readonly ChatRevealTailOwner[];
  readonly groups?: readonly ChatRevealTailOwner[];
  readonly outcome?: unknown;
};

type TailGroup = {
  key?: string;
  role?: string;
  messages?: readonly unknown[];
};

function readTailActionOwner(owner: ChatRevealTailOwner): unknown {
  const outcome = owner.outcome;
  return typeof outcome === "object" && outcome !== null && "actionOwner" in outcome
    ? (outcome as { actionOwner?: unknown }).actionOwner
    : undefined;
}

function collectTailGroups(owner: ChatRevealTailOwner, groups: TailGroup[]): TailGroup[] {
  if (owner.kind === "group") {
    groups.push(owner);
    return groups;
  }
  for (const group of owner.groups ?? []) {
    collectTailGroups(group, groups);
  }
  for (const part of owner.parts ?? []) {
    collectTailGroups(part, groups);
  }
  return groups;
}

/**
 * The rendered group that owns the settled final answer, plus its message item
 * keys: the renderer asks about the group key while the reveal entry is keyed
 * by the item key (`group:<role>:<itemKey>` vs `<itemKey>`).
 */
function revealOwnerTailKeys(owner: ChatRevealTailOwner | null): string[] {
  if (!owner) {
    return [];
  }
  const groups = collectTailGroups(owner, []).filter(
    (group): group is TailGroup & { key: string } => Boolean(group.key),
  );
  const actionOwner = readTailActionOwner(owner);
  const actionGroup = actionOwner
    ? groups.find((group) => group.messages?.includes(actionOwner))
    : undefined;
  const selected =
    actionGroup ??
    groups.findLast((group) => group.role === "assistant") ??
    groups.at(-1) ??
    (owner.key ? { key: owner.key, messages: [] } : undefined);
  if (!selected) {
    return [];
  }
  const itemKeys = (selected.messages ?? []).flatMap((message) => {
    const key = (message as { key?: unknown })?.key;
    return typeof key === "string" && key ? [key] : [];
  });
  return [selected.key, ...itemKeys];
}

type RevealEntry = {
  /** Buffer-local identity (`runKey\0rowKey`); the row keeps its own key too. */
  entryKey: string;
  runKey: string;
  key: string;
  text: string;
  revealed: number;
  streaming: boolean;
  /** A settled successor already continued this row; never hand off twice. */
  handedOff: boolean;
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
const MAX_PANE_BUFFERS = 8;
// Runs of Markdown emphasis/code/escape markers stay whole so a reveal step
// never paints a lone `*` or backslash before its partner arrives.
const MARKDOWN_MARKER_CODEPOINTS = new Set([0x60, 0x2a, 0x5f, 0x7e, 0x5c]);

const graphemeSegmenter =
  typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

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

/** Extend a cut to the end of the grapheme cluster it lands in. */
function graphemeCeil(text: string, index: number): number {
  if (!graphemeSegmenter || index <= 0 || index >= text.length) {
    return index;
  }
  const cluster = containingSegment(graphemeSegmenter.segment(text), text, index);
  return cluster && cluster.index < index ? cluster.index + cluster.segment.length : index;
}

/** Largest whole-grapheme cut at or below the index, for retraction clamps. */
function graphemeFloor(text: string, index: number): number {
  if (!graphemeSegmenter || index <= 0 || index >= text.length) {
    return index;
  }
  const cluster = containingSegment(graphemeSegmenter.segment(text), text, index);
  return cluster && cluster.index < index ? cluster.index : index;
}

/**
 * Extend a candidate cut to the end of the grapheme cluster it lands in, then
 * keep a Markdown marker run whole. Grapheme boundaries come from the shared
 * normalization owner, so flags, ZWJ sequences, keycaps, and modifiers are
 * never split.
 */
export function snapRevealIndex(text: string, index: number): number {
  if (index <= 0) {
    return 0;
  }
  let cut = Math.min(index, text.length);
  if (!graphemeSegmenter && cut < text.length) {
    // Without a segmenter only surrogate safety is available.
    const trailing = text.charCodeAt(cut);
    if (trailing >= 0xdc00 && trailing <= 0xdfff) {
      cut += 1;
    }
  }
  cut = graphemeCeil(text, cut);
  // An escape marker owns the grapheme it escapes.
  const marker = codePointBefore(text, cut);
  if (marker !== null && MARKDOWN_MARKER_CODEPOINTS.has(marker)) {
    while (cut < text.length && text.charCodeAt(cut) === marker) {
      cut += 1;
    }
    if (marker === 0x5c && cut < text.length && text.charCodeAt(cut) !== 0x0a) {
      cut += text.codePointAt(cut)! > 0xffff ? 2 : 1;
    }
  }
  // Escape/backslash extension may land inside the escaped cluster; the shared
  // grapheme owner has the final say so the following grapheme stays whole.
  return graphemeCeil(text, cut);
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
function entryKeyFor(runKey: string, rowKey: string): string {
  return `${runKey}\u0000${rowKey}`;
}

function revealStartIndex(text: string): number {
  const start = skipWhitespaceGraphemes(text);
  if (start >= text.length) {
    return text.length;
  }
  return start + firstGraphemeClusterLength(text.slice(start));
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
  /** Focused tail row keys and the run each was focused under. */
  private readonly tailRunIds = new Map<string, string | null>();
  private sessionKey: string | null = null;
  private connectionEpoch: number | undefined;
  /** Run that owns reveal state; superseded runs are retired on identity change. */
  private activeRunId: string | null = null;
  /** Live stream row per run, noted by the projection while it streams. */
  private readonly liveStreamKeys = new Map<string, string>();
  /** The one stream entry a settled final may continue from (identity, not recency). */
  private successor: { runKey: string; entryKey: string } | null = null;
  /** Newest streaming entry, retained for rendering diagnostics of the live row. */
  private activeStreamEntryKey: string | null = null;
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
   * One call per transcript projection. The buffer owns three lifecycle facts:
   * a session switch or connection transition retires everything (a disconnect
   * must not keep repainting), a different run supersedes the previous run's
   * work, and a settled run keeps its intentional final drain. A settled
   * history load arms the live run so only text that arrives after the pane
   * attached animates; a replay during initial load paints.
   */
  beginPass(pass: {
    sessionKey: string;
    connectionEpoch?: number;
    runId?: string | null;
    live: boolean;
    historySettled: boolean;
    scheduleUpdate: () => void;
  }): void {
    const epochChanged =
      pass.connectionEpoch !== undefined &&
      this.connectionEpoch !== undefined &&
      pass.connectionEpoch !== this.connectionEpoch;
    if (this.sessionKey !== pass.sessionKey || epochChanged) {
      this.reset();
      this.sessionKey = pass.sessionKey;
    }
    this.connectionEpoch = pass.connectionEpoch ?? this.connectionEpoch;
    this.pass += 1;
    this.scheduleUpdate = pass.scheduleUpdate;
    const incomingRun = pass.runId ?? null;
    if (incomingRun !== null && incomingRun !== this.activeRunId) {
      if (this.activeRunId !== null) {
        // A different run owns the pane now; the previous run's reveal is
        // retired rather than left repainting offscreen.
        this.retireRun(this.activeRunId);
      }
      this.activeRunId = incomingRun;
    }
    if (incomingRun !== null) {
      this.liveRunId = incomingRun;
    }
    if (!pass.live || !incomingRun) {
      return;
    }
    const observation = this.runs.get(incomingRun) ?? {
      firstPass: this.pass,
      armed: false,
      entries: 0,
    };
    // A run observed live in an earlier pass is producing new output; the same
    // pass that first sees a run is its attached history and must not animate.
    if (pass.historySettled && observation.firstPass < this.pass) {
      observation.armed = true;
    }
    this.runs.delete(incomingRun);
    this.runs.set(incomingRun, observation);
    this.pruneRuns();
  }

  versionForRun(runId?: string | null): number {
    const runKey = this.resolveRunKey(runId);
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
   * The projection notes the live stream row of a run while it streams; the
   * settled final can only continue from this exact entry, never from whichever
   * same-run row rendered most recently.
   */
  noteLiveStream(runId: string | null | undefined, key: string | null | undefined): void {
    const runKey = this.resolveRunKey(runId);
    if (runKey && key) {
      this.liveStreamKeys.set(runKey, key);
    }
  }

  /**
   * The pane's settled final answer is the only identity-less row that may
   * animate; returns its key so the caller can keep one owner for both facts.
   * The tail's originating stream entry is bound by run identity here.
   */
  focusTail(owner: ChatRevealTailOwner | null, runId?: string | null): string | null {
    // A null owner keeps the previous tail: an answer that is still revealing
    // must not jump while the next run is starting. New tails replace the set.
    if (owner) {
      const tailRunKey = this.resolveRunKey(runId ?? this.activeRunId);
      this.tailRunIds.clear();
      for (const key of revealOwnerTailKeys(owner)) {
        // The tail belongs to the run that owned the pane when it settled; a
        // later run must not animate a stale identity-less row.
        this.tailRunIds.set(key, tailRunKey || this.activeRunId);
      }
      const liveKey = tailRunKey ? this.liveStreamKeys.get(tailRunKey) : undefined;
      this.successor = liveKey
        ? { runKey: tailRunKey, entryKey: entryKeyFor(tailRunKey, liveKey) }
        : null;
    }
    return owner?.key ?? null;
  }

  isTail(rowKey: string): boolean {
    return this.tailRunIds.has(rowKey);
  }

  /** Visible prefix for one row; the canonical text itself is never rewritten. */
  visibleText(request: ChatRevealRequest): ChatRevealText {
    const text = request.text;
    if (!text) {
      return { text, revealing: false };
    }
    const runKey = this.resolveRequestRunKey(request);
    const observation = this.runs.get(runKey);
    // History rows and other runs never animate, so their renders stay free of
    // buffer bookkeeping even with hundreds of visible messages.
    if (!observation) {
      return { text, revealing: false };
    }
    const entryKey = entryKeyFor(runKey, request.key);
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
    const settledTail = request.liveTail === true && request.streaming !== true;
    const inherited = settledTail ? this.handoff(runKey, text) : null;
    if (inherited === "settled") {
      this.complete(entryKey);
      return { text, revealing: false };
    }
    if (typeof inherited === "number") {
      return this.startEntry(runKey, entryKey, request, inherited);
    }
    if (settledTail && this.runHasEntries(runKey)) {
      // The run already painted output this settled row cannot continue from.
      // Painting it settled avoids retracting or restarting text the reader
      // already saw, and keeps sibling rows independent.
      this.complete(entryKey);
      return { text, revealing: false };
    }
    if (!observation.armed) {
      // Attached to a run that was already producing text: paint its backlog
      // and animate only what arrives afterwards.
      return this.startEntry(runKey, entryKey, request, text.length);
    }
    return this.startEntry(runKey, entryKey, request, 0);
  }

  /** Cancel in-flight work while keeping the pane registration (disconnect/hide). */
  cancel(): void {
    this.reset();
  }

  dispose(): void {
    this.reset();
    this.sessionKey = null;
    this.connectionEpoch = undefined;
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

  private resolveRunKey(runId: string | null | undefined): string {
    return runId ?? this.liveRunId ?? "";
  }

  private resolveRequestRunKey(request: ChatRevealRequest): string {
    if (request.runId) {
      return request.runId;
    }
    // An unowned stream part belongs to the live run; an identity-less settled
    // row belongs to the run it was focused under, never a later run.
    if (request.streaming === true) {
      return this.liveRunId ?? "";
    }
    if (request.liveTail === true) {
      return this.tailRunIds.get(request.key) ?? "";
    }
    return "";
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
      handedOff: false,
      version: ++this.version,
    };
    this.entries.set(entryKey, entry);
    if (entry.streaming) {
      this.activeStreamEntryKey = entryKey;
    }
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
    if (entry.streaming && !entry.handedOff) {
      this.activeStreamEntryKey = entry.entryKey;
    }
    if (entry.text !== request.text) {
      const painted = entry.text.slice(0, entry.revealed);
      entry.text = request.text;
      // Keep every already painted character that the new canonical text still
      // contains, snapped down to a whole grapheme; the row may swap identity
      // (stream segment -> final message).
      entry.revealed = Math.min(
        entry.revealed,
        graphemeFloor(request.text, commonPrefixLength(painted, request.text)),
      );
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
   * Continue a settled final from the stream entry the projection bound to this
   * run. Ownership is identity, not recency or prefix similarity: without that
   * exact predecessor the settled row paints settled (never another row's
   * position, never a restart). The source keeps its own reveal.
   */
  private handoff(runKey: string, text: string): "settled" | number | null {
    const successor = this.successor;
    if (!successor || successor.runKey !== runKey) {
      return null;
    }
    // One-to-one: the first settled final consumes the live stream binding.
    this.successor = null;
    const source = this.entries.get(successor.entryKey);
    if (!source) {
      return "settled";
    }
    const painted = source.text.slice(0, source.revealed);
    if (!painted || !text.startsWith(painted)) {
      return "settled";
    }
    source.handedOff = true;
    if (this.activeStreamEntryKey === source.entryKey) {
      this.activeStreamEntryKey = null;
    }
    return source.revealed;
  }

  private runHasEntries(runKey: string): boolean {
    for (const entry of this.entries.values()) {
      if (entry.runKey === runKey) {
        return true;
      }
    }
    return false;
  }

  private complete(entryKey: string): void {
    const entry = this.entries.get(entryKey);
    if (!entry) {
      return;
    }
    this.entries.delete(entryKey);
    if (this.activeStreamEntryKey === entryKey) {
      this.activeStreamEntryKey = null;
    }
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

  /** Drops every reveal entry the superseded run still owned. */
  private retireRun(runKey: string): void {
    for (const [entryKey, entry] of this.entries) {
      if (entry.runKey === runKey) {
        this.entries.delete(entryKey);
      }
    }
    this.runs.delete(runKey);
    this.liveStreamKeys.delete(runKey);
    if (this.successor?.runKey === runKey) {
      this.successor = null;
    }
    this.activeStreamEntryKey = null;
    if (!this.hasRemaining()) {
      this.stopFrames();
    }
  }

  private stopFrames(): void {
    if (this.frame !== null) {
      this.clock.cancelFrame(this.frame);
      this.frame = null;
    }
  }

  private reset(): void {
    this.stopFrames();
    this.entries.clear();
    this.completed.clear();
    this.runs.clear();
    this.tailRunIds.clear();
    this.liveStreamKeys.clear();
    this.successor = null;
    this.activeStreamEntryKey = null;
    this.activeRunId = null;
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

/**
 * Pane disconnect/hide owner: cancel pending frames and reveal state without
 * waiting for another projection, while keeping the pane registration.
 */
export function cancelChatReveal(paneId: string): void {
  paneBuffers.get(paneId)?.cancel();
}

export type ChatRevealLiveRow = {
  readonly kind?: string;
  readonly key?: string;
  readonly isStreaming?: boolean;
  readonly runId?: string;
};

/**
 * Projection helper: bind the run's live stream row while it streams. The
 * settled final can only continue from this identity, never by recency.
 */
export function trackRevealLiveStream(
  reveal: ChatRevealBuffer,
  runId: string | null | undefined,
  stream: string | null | undefined,
  items: readonly ChatRevealLiveRow[],
): void {
  if ((stream ?? null) === null) {
    return;
  }
  const live = items.findLast(
    (item) =>
      item.kind === "stream" && item.isStreaming && (!runId || !item.runId || item.runId === runId),
  );
  reveal.noteLiveStream(runId ?? live?.runId, live?.key);
}

/** Pane teardown owner: drop all reveal work and the pane's buffer entry. */
export function disposeChatReveal(paneId: string): void {
  const buffer = paneBuffers.get(paneId);
  buffer?.dispose();
  paneBuffers.delete(paneId);
}

/** Transcript-projection entry: scope the pane's reveal to its session and run. */
export function beginChatReveal(
  props: {
    paneId: string;
    connectionEpoch?: number;
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
    connectionEpoch: props.connectionEpoch,
    runId: props.runId ?? null,
    live:
      Boolean(props.runId || props.runActive || props.runWorking) ||
      (props.stream ?? null) !== null,
    historySettled: !props.loading,
    scheduleUpdate,
  });
  return buffer;
}
