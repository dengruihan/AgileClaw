// Markdown TeX detection plus one lazy KaTeX renderer for chat transcripts.
// Detection is pure so the parser, the streaming split guard, and the chat
// renderer share one bounded grammar; KaTeX and its stylesheet stay behind a
// dynamic import so ordinary chat and `/new` startup never fetch them.
import { findMarkdownCodeSpans } from "../../../packages/markdown-core/src/reasoning-tags.js";
import { escapeHtml } from "../../../src/shared/html-escape.js";

export const MARKDOWN_MATH_CLASS = "markdown-math";
export const MARKDOWN_MATH_DISPLAY_CLASS = "markdown-math--display";
export const MARKDOWN_CHAT_MATH_TAG = "openclaw-chat-math";

// Inline math is a phrase; display math holds aligned blocks and matrices.
export const MARKDOWN_MATH_INLINE_LIMIT = 1_000;
export const MARKDOWN_MATH_DISPLAY_LIMIT = 4_000;
// KaTeX expands macros while typesetting; both caps bound hostile input cost.
const MARKDOWN_MATH_MAX_EXPAND = 100;
const MARKDOWN_MATH_MAX_SIZE = 8;

type MarkdownMathMatch = {
  /** Offset of the opening delimiter. */
  start: number;
  /** Offset just past the closing delimiter. */
  end: number;
  /** Offset of the first TeX character. */
  contentStart: number;
  /** Offset just past the last TeX character. */
  contentEnd: number;
  display: boolean;
};

// Cheap probe before the delimiter scan; ordinary prose exits here.
const MARKDOWN_MATH_CANDIDATE_RE = /[$]|\\[()[\]]/u;
const MARKDOWN_MATH_NEWLINE_RE = /\n/u;
// A digit-leading `$…$` span needs an operator, a TeX command, or an implicit
// factor such as `2x`, `2(x)`, or `2!`. Amounts such as `$5` or `$1.50` stay
// currency without rejecting real formulas like `$2+2=4$`.
const MARKDOWN_MATH_NUMERIC_HINT_RE = /[=+\-*/^_{}<>|\\]/u;
const MARKDOWN_MATH_NUMERIC_PREFIX_RE = /^\d+(?:[.,]\d+)*/u;
const MARKDOWN_MATH_FACTORIAL_RE = /[!'\u2019]/u;
const MARKDOWN_MATH_LETTER_RE = /^\p{L}+/u;
const MARKDOWN_MATH_TEX_COMMAND_RE = /^\\[a-zA-Z]+/u;

function isEscaped(source: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source.charAt(cursor) === "\\"; cursor--) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function bracketMathAt(
  source: string,
  start: number,
  marker: "(" | "[",
  allowNewlines: boolean,
): MarkdownMathMatch | null {
  const closer = marker === "(" ? "\\)" : "\\]";
  const contentStart = start + 2;
  const closing = source.indexOf(closer, contentStart);
  if (closing === -1) {
    return null;
  }
  const content = source.slice(contentStart, closing);
  if (!content.trim() || (!allowNewlines && MARKDOWN_MATH_NEWLINE_RE.test(content))) {
    return null;
  }
  const limit = marker === "(" ? MARKDOWN_MATH_INLINE_LIMIT : MARKDOWN_MATH_DISPLAY_LIMIT;
  if (content.length > limit) {
    return null;
  }
  return {
    start,
    end: closing + closer.length,
    contentStart,
    contentEnd: closing,
    display: marker === "[",
  };
}

/** End offset of one implicit factor at `start`, or -1 when none starts there. */
function markdownMathFactorEnd(content: string, start: number): number {
  const character = content.charAt(start);
  if (character === "(") {
    let depth = 0;
    for (let index = start; index < content.length; index++) {
      const current = content.charAt(index);
      if (current === "$") {
        return -1;
      }
      if (current === "(") {
        depth += 1;
      } else if (current === ")") {
        depth -= 1;
        if (depth === 0) {
          return index + 1;
        }
      }
    }
    return -1;
  }
  if (character === "\\") {
    const command = MARKDOWN_MATH_TEX_COMMAND_RE.exec(content.slice(start));
    return command ? start + command[0].length : -1;
  }
  const letters = MARKDOWN_MATH_LETTER_RE.exec(content.slice(start));
  return letters ? start + letters[0].length : -1;
}

/**
 * Implicit multiplication and factorials bind directly to the numeric prefix:
 * `2x`, `2xy`, `2(x)`, `2.5x`, `2!`. A space ends the check, so prose that
 * merely starts with a number (`2x marks the spot`) is never classified.
 */
function isImplicitNumericMarkdownMath(content: string): boolean {
  const prefix = MARKDOWN_MATH_NUMERIC_PREFIX_RE.exec(content)?.[0];
  if (!prefix) {
    return false;
  }
  let index = prefix.length;
  let factors = 0;
  while (index < content.length) {
    if (MARKDOWN_MATH_FACTORIAL_RE.test(content.charAt(index))) {
      while (index < content.length && MARKDOWN_MATH_FACTORIAL_RE.test(content.charAt(index))) {
        index += 1;
      }
      factors += 1;
      continue;
    }
    const factorEnd = markdownMathFactorEnd(content, index);
    if (factorEnd === -1) {
      return false;
    }
    index = factorEnd;
    factors += 1;
  }
  return factors > 0;
}

function isNumericLeadingMarkdownMath(content: string): boolean {
  // A stray `$` means the candidate closer belongs to a later span, so prose
  // between two amounts (`$5 today. Then $x$`) never pairs into math.
  for (let index = content.indexOf("$"); index !== -1; index = content.indexOf("$", index + 1)) {
    if (!isEscaped(content, index)) {
      return false;
    }
  }
  return MARKDOWN_MATH_NUMERIC_HINT_RE.test(content) || isImplicitNumericMarkdownMath(content);
}

function dollarMathAt(
  source: string,
  start: number,
  allowNewlines: boolean,
): MarkdownMathMatch | null {
  const contentStart = start + 1;
  if (source.charAt(contentStart) === "$") {
    const displayContentStart = start + 2;
    const closing = source.indexOf("$$", displayContentStart);
    if (closing === -1) {
      return null;
    }
    const content = source.slice(displayContentStart, closing);
    if (
      !content.trim() ||
      content.length > MARKDOWN_MATH_DISPLAY_LIMIT ||
      (!allowNewlines && MARKDOWN_MATH_NEWLINE_RE.test(content))
    ) {
      return null;
    }
    return {
      start,
      end: closing + 2,
      contentStart: displayContentStart,
      contentEnd: closing,
      display: true,
    };
  }
  const first = source.charAt(contentStart);
  // An opening `$` binds to its content: `$ 5` stays currency.
  if (!first || /\s/u.test(first)) {
    return null;
  }
  const numericLeading = /[0-9]/u.test(first);
  // The scan budget precedes closer validity, so repeated amounts cannot walk
  // the remaining suffix; every closer inside the budget is still examined.
  const scanLimit = contentStart + MARKDOWN_MATH_INLINE_LIMIT;
  for (let cursor = contentStart + 1; cursor < source.length; cursor++) {
    if (cursor > scanLimit) {
      return null;
    }
    const character = source.charAt(cursor);
    if (character === "\n" && !allowNewlines) {
      return null;
    }
    if (character !== "$" || isEscaped(source, cursor)) {
      continue;
    }
    // A closing `$` binds to its content and cannot precede a digit, so
    // `$5 and $10` and `$1.50` never become math.
    if (/\s/u.test(source.charAt(cursor - 1))) {
      continue;
    }
    const after = source.charAt(cursor + 1);
    if (after && /[0-9]/u.test(after)) {
      continue;
    }
    if (numericLeading && !isNumericLeadingMarkdownMath(source.slice(contentStart, cursor))) {
      continue;
    }
    return {
      start,
      end: cursor + 1,
      contentStart,
      contentEnd: cursor,
      display: false,
    };
  }
  return null;
}

/**
 * Matches TeX delimited math starting exactly at `start`.
 *
 * Supported openers are `$`, `$$`, `\(`, and `\[`. A match is returned only
 * when its closer exists inside the bounds, so callers never see half a span.
 */
export function markdownMathAt(
  source: string,
  start: number,
  options: { allowNewlines?: boolean } = {},
): MarkdownMathMatch | null {
  const allowNewlines = options.allowNewlines ?? true;
  const opener = source.charAt(start);
  if (opener === "\\") {
    const marker = source.charAt(start + 1);
    if ((marker !== "(" && marker !== "[") || isEscaped(source, start)) {
      return null;
    }
    return bracketMathAt(source, start, marker, allowNewlines);
  }
  if (opener !== "$" || isEscaped(source, start)) {
    return null;
  }
  return dollarMathAt(source, start, allowNewlines);
}

/** True when `start` holds an unescaped delimiter that could open math. */
export function isMarkdownMathDelimiterStart(source: string, start: number): boolean {
  const opener = source.charAt(start);
  if (opener === "$") {
    return !isEscaped(source, start);
  }
  if (opener !== "\\" || isEscaped(source, start)) {
    return false;
  }
  const marker = source.charAt(start + 1);
  return marker === "(" || marker === "[";
}

/**
 * Reports whether `text` holds a math delimiter that never closes.
 *
 * The streaming splitter hands rendered stable prefixes to an incremental
 * append path; a prefix that still owns an open delimiter must not be extended
 * with separately rendered HTML, because the equation only exists across both
 * halves. Code spans are skipped so their delimiters neither pair nor open.
 */
export function hasUnpairedMarkdownMath(text: string): boolean {
  if (!MARKDOWN_MATH_CANDIDATE_RE.test(text)) {
    return false;
  }
  const codeSpans = findMarkdownCodeSpans(text);
  let spanIndex = 0;
  for (let position = 0; position < text.length;) {
    while (codeSpans[spanIndex] && codeSpans[spanIndex]![1] <= position) {
      spanIndex += 1;
    }
    const span = codeSpans[spanIndex];
    if (span && span[0] <= position && position < span[1]) {
      position = span[1];
      continue;
    }
    const match = markdownMathAt(text, position);
    if (match) {
      position = match.end;
      continue;
    }
    if (isMarkdownMathDelimiterStart(text, position)) {
      return true;
    }
    position += 1;
  }
  return false;
}

/** True when the delimited source may be handed to KaTeX at all. */
function isMarkdownMathSourceWithinLimit(source: string, display: boolean): boolean {
  return source.length <= (display ? MARKDOWN_MATH_DISPLAY_LIMIT : MARKDOWN_MATH_INLINE_LIMIT);
}

/** Reads the TeX and delimited source back out of a parser placeholder. */
export function readMarkdownMathPlaceholder(node: Element): {
  source: string;
  display: boolean;
  /** Delimited text the model wrote, retained for copy consumers. */
  delimitedSource: string;
} | null {
  if (!node.classList.contains(MARKDOWN_MATH_CLASS)) {
    return null;
  }
  const display = node.classList.contains(MARKDOWN_MATH_DISPLAY_CLASS);
  const fallback = node.textContent ?? "";
  const match = markdownMathAt(fallback, 0);
  return {
    source: match ? fallback.slice(match.contentStart, match.contentEnd) : fallback,
    display: display || Boolean(match?.display),
    delimitedSource: fallback,
  };
}

/** Rendered markup a placeholder stands in for until the lazy renderer runs. */
export function markdownMathPlaceholderHtml(source: string, display: boolean): string {
  const content = escapeHtml(source);
  return display
    ? `<div class="${MARKDOWN_MATH_CLASS} ${MARKDOWN_MATH_DISPLAY_CLASS}">${content}</div>`
    : `<span class="${MARKDOWN_MATH_CLASS}">${content}</span>`;
}

export type MarkdownMathRenderResult = "rendered" | "skipped" | "unavailable";

type KatexModule = typeof import("katex");

let katexLoader: Promise<KatexModule> | undefined;
let stylesRequested = false;

function loadKatex(): Promise<KatexModule> {
  katexLoader ??= import("katex").catch((error: unknown) => {
    katexLoader = undefined;
    throw error;
  });
  return katexLoader;
}

/**
 * Fetches the math stylesheets beside the engine. Presentation failure must not
 * cost the equation, so a blocked stylesheet leaves KaTeX's own markup visible.
 */
function loadKatexStyles(): void {
  if (stylesRequested) {
    return;
  }
  stylesRequested = true;
  void Promise.all([import("katex/dist/katex.min.css"), import("./markdown-math.css")]).catch(
    (error: unknown) => {
      console.warn("[markdown] math stylesheet unavailable:", error);
    },
  );
}

/**
 * Typesets `source` into `target` with a fresh, bounded KaTeX invocation.
 *
 * `trust: false` is the security boundary: KaTeX then refuses `\href`, `\url`,
 * `\includegraphics`, and `\html*` payloads, so model-authored TeX can never
 * create a link, load a remote resource, or inject raw HTML.
 */
export async function renderMarkdownMathInto(
  target: HTMLElement,
  source: string,
  display: boolean,
): Promise<MarkdownMathRenderResult> {
  if (!isMarkdownMathSourceWithinLimit(source, display)) {
    return "skipped";
  }
  let katex: KatexModule;
  try {
    katex = await loadKatex();
  } catch {
    return "unavailable";
  }
  loadKatexStyles();
  try {
    katex.default.render(source, target, {
      displayMode: display,
      throwOnError: false,
      trust: false,
      strict: "ignore",
      maxExpand: MARKDOWN_MATH_MAX_EXPAND,
      maxSize: MARKDOWN_MATH_MAX_SIZE,
      output: "htmlAndMathml",
    });
    return "rendered";
  } catch {
    return "unavailable";
  }
}
