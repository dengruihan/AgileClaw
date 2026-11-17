import MarkdownIt, { type Token } from "markdown-it";
import markdownItCjkFriendly from "markdown-it-cjk-friendly";
import type { PdfTextStyle } from "./pdf-text.ts";

/** One styled inline fragment of a block; "\n" forces a line break. */
export type PdfSpan = { text: string; style: PdfTextStyle };

export type PdfBlock =
  | { kind: "heading"; level: number; spans: PdfSpan[] }
  | { kind: "paragraph"; spans: PdfSpan[]; indent: number; quote: boolean }
  | { kind: "listItem"; marker: string; spans: PdfSpan[]; indent: number }
  | { kind: "code"; text: string }
  | { kind: "rule" };

const BULLETS = ["\u2022", "\u25E6", "\u25AA"];

// Raw HTML stays literal text (html: false), so an export can never execute markup.
const parser = new MarkdownIt({ html: false, breaks: true, linkify: true }).use(
  markdownItCjkFriendly,
);
parser.linkify.set({ fuzzyLink: false });

type ListFrame = { ordered: boolean; index: number };

function span(text: string, style: PdfTextStyle): PdfSpan {
  return { text, style };
}

function stripTagNoise(text: string): string {
  return text.replace(/<br\s*\/?>/giu, "\n").replace(/<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?\/?>/giu, "");
}

function linkTarget(children: readonly Token[], openIndex: number): string | null {
  const token = children[openIndex];
  const href = token?.attrGet("href");
  return typeof href === "string" && href.trim() ? href.trim() : null;
}

function inlineSpans(children: readonly Token[]): PdfSpan[] {
  const spans: PdfSpan[] = [];
  const state: PdfTextStyle = {};
  const links: { href: string; start: number }[] = [];
  const push = (text: string, style: PdfTextStyle) => {
    const last = spans.at(-1);
    if (
      last &&
      last.style.bold === style.bold &&
      last.style.code === style.code &&
      last.style.italic === style.italic
    ) {
      last.text += text;
      return;
    }
    spans.push({ text, style: { ...style } });
  };
  for (let index = 0; index < children.length; index += 1) {
    const token = children[index]!;
    switch (token.type) {
      case "text":
        push(stripTagNoise(token.content), state);
        break;
      case "code_inline":
        push(token.content, { ...state, code: true });
        break;
      case "strong_open":
        state.bold = true;
        break;
      case "strong_close":
        state.bold = false;
        break;
      case "em_open":
        state.italic = true;
        break;
      case "em_close":
        state.italic = false;
        break;
      case "s_open":
      case "s_close":
      case "strikethrough_open":
      case "strikethrough_close":
        break;
      case "link_open": {
        const href = linkTarget(children, index);
        links.push({ href: href ?? "", start: spans.length });
        break;
      }
      case "link_close": {
        const link = links.pop();
        // A bare autolink repeats its target; only authored labels need the URL.
        if (link?.href && /^https?:\/\//iu.test(link.href)) {
          const label = spans
            .slice(link.start)
            .map((entry) => entry.text)
            .join("");
          if (!label.includes(link.href)) {
            push(` (${link.href})`, { ...state });
          }
        }
        break;
      }
      case "image":
        push(token.content || String(token.attrGet("alt") ?? ""), { ...state, italic: true });
        break;
      case "softbreak":
      case "hardbreak":
        // The chat renderer runs markdown-it with breaks: true, so both are line breaks.
        push("\n", state);
        break;
      case "html_inline":
        push(stripTagNoise(token.content), state);
        break;
      default:
        break;
    }
  }
  return spans.filter((entry) => entry.text.length > 0);
}

function listMarker(frames: readonly ListFrame[]): string {
  const frame = frames.at(-1);
  if (!frame) {
    return BULLETS[0]!;
  }
  return frame.ordered ? `${frame.index}.` : BULLETS[(frames.length - 1) % BULLETS.length]!;
}

/** Flattens a message's Markdown into the block vocabulary the PDF layout understands. */
export function markdownToPdfBlocks(markdown: string): PdfBlock[] {
  const tokens = parser.parse(markdown, {});
  const blocks: PdfBlock[] = [];
  const lists: ListFrame[] = [];
  let quoteDepth = 0;
  let pending: { kind: "heading"; level: number } | { kind: "paragraph" } | null = null;
  let itemParagraphs = 0;
  let tableRow: string[] | null = null;

  for (const token of tokens) {
    switch (token.type) {
      case "heading_open":
        pending = { kind: "heading", level: Number(token.tag.slice(1)) || 1 };
        break;
      case "paragraph_open":
        pending = { kind: "paragraph" };
        break;
      case "bullet_list_open":
        lists.push({ ordered: false, index: 1 });
        break;
      case "ordered_list_open":
        lists.push({ ordered: true, index: 1 });
        break;
      case "bullet_list_close":
      case "ordered_list_close":
        lists.pop();
        break;
      case "list_item_open":
        itemParagraphs = 0;
        break;
      case "list_item_close": {
        const frame = lists.at(-1);
        if (frame) {
          frame.index += 1;
        }
        break;
      }
      case "blockquote_open":
        quoteDepth += 1;
        break;
      case "blockquote_close":
        quoteDepth = Math.max(0, quoteDepth - 1);
        break;
      case "table_open":
        break;
      case "tr_open":
        tableRow = [];
        break;
      case "tr_close":
        if (tableRow && tableRow.some((cell) => cell.trim())) {
          blocks.push({
            kind: "paragraph",
            spans: [span(tableRow.join(" \u2502 "), {})],
            indent: 0,
            quote: false,
          });
        }
        tableRow = null;
        break;
      case "inline": {
        const spans = inlineSpans(token.children ?? []);
        if (tableRow) {
          tableRow.push(spans.map((entry) => entry.text).join(""));
          break;
        }
        if (!spans.length) {
          break;
        }
        if (pending?.kind === "heading") {
          blocks.push({ kind: "heading", level: pending.level, spans });
          break;
        }
        const indent = quoteDepth * 10;
        if (lists.length > 0) {
          const marker = itemParagraphs === 0 ? listMarker(lists) : "";
          blocks.push({
            kind: "listItem",
            marker,
            spans,
            indent: indent + (lists.length - 1) * 14,
          });
          itemParagraphs += 1;
          break;
        }
        blocks.push({ kind: "paragraph", spans, indent, quote: quoteDepth > 0 });
        break;
      }
      case "fence":
      case "code_block":
        if (token.content.trim()) {
          blocks.push({ kind: "code", text: token.content.replace(/\n+$/u, "") });
        }
        break;
      case "hr":
        blocks.push({ kind: "rule" });
        break;
      default:
        break;
    }
    if (token.type === "paragraph_close") {
      pending = null;
    }
    if (token.type === "heading_close") {
      pending = null;
    }
  }
  return blocks;
}
