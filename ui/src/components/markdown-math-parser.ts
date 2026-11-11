// Math rules for the shared Markdown parser: block and inline TeX delimiters
// become typed placeholders that the chat renderer typesets lazily.
import type { MarkdownIt, StateBlock, StateInline, Token } from "markdown-it";
import {
  MARKDOWN_MATH_DISPLAY_LIMIT,
  markdownMathAt,
  markdownMathPlaceholderHtml,
} from "./markdown-math.ts";

const MATH_BLOCK_MAX_LINES = 64;
const MATH_INLINE_DOLLAR = 0x24;
const MATH_INLINE_BACKSLASH = 0x5c;

type MarkdownMathTokenMeta = {
  mathDisplay: boolean;
  /** Delimited source kept verbatim so the placeholder stays readable. */
  mathSource: string;
};

function mathTokenMeta(token: Token | undefined): MarkdownMathTokenMeta | undefined {
  return token?.meta as MarkdownMathTokenMeta | undefined;
}

function renderMathPlaceholder(token: Token | undefined, display: boolean): string {
  const meta = mathTokenMeta(token);
  return typeof meta?.mathSource === "string"
    ? markdownMathPlaceholderHtml(meta.mathSource, display)
    : "";
}

/** One line of block content with its container marker and indent removed. */
function mathBlockLine(state: StateBlock, line: number): string {
  return state.getLines(line, line + 1, state.blkIndent, false);
}

function mathBlock(
  state: StateBlock,
  startLine: number,
  endLine: number,
  silent: boolean,
): boolean {
  if (state.sCount[startLine]! - state.blkIndent >= 4) {
    return false;
  }
  const opening = mathBlockLine(state, startLine);
  const delimiter = opening.startsWith("$$") ? "$$" : opening.startsWith("\\[") ? "\\[" : null;
  if (!delimiter) {
    return false;
  }
  const closer = delimiter === "$$" ? "$$" : "\\]";
  const after = opening.slice(delimiter.length);
  let lastLine = startLine;
  let content: string;
  let multiline = false;
  if (after.trim()) {
    // A single-line display block closes on the same line it opens.
    const closing = after.indexOf(closer);
    const trailing = closing === -1 ? "" : after.slice(closing + closer.length);
    if (closing <= 0 || trailing.trim()) {
      return false;
    }
    content = after.slice(0, closing);
  } else {
    // Unterminated blocks stay ordinary prose so a streaming tail never paints
    // half an equation as a frozen display block.
    multiline = true;
    let closed = false;
    for (lastLine = startLine + 1; lastLine < endLine; lastLine++) {
      if (lastLine - startLine > MATH_BLOCK_MAX_LINES) {
        return false;
      }
      const line = mathBlockLine(state, lastLine);
      if (line.trim() === closer) {
        closed = true;
        break;
      }
      if (line.trimEnd().endsWith(closer)) {
        // The closer may share the last content line: `x = 1$$`.
        closed = true;
        break;
      }
    }
    if (!closed) {
      return false;
    }
    const body =
      lastLine === startLine + 1
        ? ""
        : state.getLines(startLine + 1, lastLine, state.blkIndent, true);
    const closingLine = mathBlockLine(state, lastLine).trimEnd().slice(0, -closer.length);
    content = `${body}${closingLine}`.replace(/^\n+/u, "").replace(/\s+$/u, "");
  }
  if (!content.trim() || content.length > MARKDOWN_MATH_DISPLAY_LIMIT) {
    return false;
  }
  if (silent) {
    state.line = lastLine + 1;
    return true;
  }
  const token = state.push("math_block", "div", 0);
  token.block = true;
  token.markup = delimiter;
  token.content = content;
  token.map = [startLine, lastLine + 1];
  token.meta = {
    mathDisplay: true,
    // Multi-line blocks keep their delimiter lines so the readable fallback
    // still shows the source the model wrote.
    mathSource: multiline
      ? `${delimiter}\n${content}\n${closer}`
      : `${delimiter}${content}${closer}`,
  };
  state.line = lastLine + 1;
  return true;
}

function mathInline(state: StateInline, silent: boolean): boolean {
  const start = state.pos;
  const character = state.src.charCodeAt(start);
  if (character !== MATH_INLINE_DOLLAR && character !== MATH_INLINE_BACKSLASH) {
    return false;
  }
  // Unmatched delimiters fall through: CommonMark escaping still owns `\[`
  // and `\(`, so ordinary prose keeps its authored escape semantics.
  const match = markdownMathAt(state.src, start, { allowNewlines: false });
  if (!match) {
    return false;
  }
  if (match.end > state.posMax) {
    return false;
  }
  if (!silent) {
    const token = state.push("math_inline", "span", 0);
    token.markup = state.src.slice(match.start, match.contentStart);
    token.content = state.src.slice(match.contentStart, match.contentEnd);
    token.meta = {
      mathDisplay: match.display,
      mathSource: state.src.slice(match.start, match.end),
    };
  }
  state.pos = match.end;
  return true;
}

/** Registers the block and inline math rules on a Markdown parser. */
export function installMarkdownMath(markdownParser: MarkdownIt): void {
  // Delimiters bind before escaping so `\(`/`\[` survive as TeX openers.
  markdownParser.inline.ruler.before("escape", "math_inline", mathInline);
  markdownParser.block.ruler.before("paragraph", "math_block", mathBlock, {
    alt: ["paragraph", "reference", "blockquote", "list"],
  });
  markdownParser.renderer.rules.math_inline = (tokens, index) =>
    renderMathPlaceholder(tokens[index], tokens[index]?.meta?.mathDisplay === true);
  markdownParser.renderer.rules.math_block = (tokens, index) =>
    `${renderMathPlaceholder(tokens[index], true)}\n`;
}
