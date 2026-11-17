import { describe, expect, it } from "vitest";
import { markdownToPdfBlocks } from "./chat-markdown-blocks.ts";
import { buildChatPdf, ChatPdfTooLargeError, type ChatPdfInput } from "./chat-pdf.ts";

const labels = {
  meta: "Exported 2026-11-17 09:30:00 UTC · 4 messages",
  attachmentsOmitted: "Attachments are not included in this export.",
  continued: "continued",
  pageOf: (page: number, count: number) => `Page ${page} of ${count}`,
  unsupportedGlyphs: (count: number) =>
    `${count} characters outside the PDF font range appear as \u25A1.`,
};

function pdfText(bytes: Uint8Array): string {
  return new TextDecoder("latin1").decode(bytes);
}

function pagesOf(document: string): number {
  const match = /\/Type \/Pages \/Kids \[[^\]]*\] \/Count (\d+)/u.exec(document);
  return Number(match?.[1] ?? 0);
}

function input(entries: ChatPdfInput["entries"]): ChatPdfInput {
  return {
    title: "Release planning",
    exportedAt: Date.parse("2026-11-17T09:30:00Z"),
    entries,
    labels,
  };
}

describe("buildChatPdf", () => {
  it("writes a real PDF with one page per rendered page and a light page panel", () => {
    const bytes = buildChatPdf(
      input([
        {
          speaker: "You",
          role: "user",
          timestampIso: "2026-11-17T09:00:00.000Z",
          body: "Summarize the release.",
          attachments: 0,
        },
        {
          speaker: "AgileClaw",
          role: "assistant",
          timestampIso: null,
          body: "## Release notes\n\n- **Ship** the light PDF\n- Keep [docs](https://example.invalid/docs)\n\n```ts\nconst total = 1 + 1;\n```",
          attachments: 0,
        },
      ]),
    );
    const document = pdfText(bytes);
    expect(document.startsWith("%PDF-1.4")).toBe(true);
    expect(document.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(pagesOf(document)).toBe(1);
    // Light theme: a near-white panel fill and dark ink, never a dark page.
    expect(document).toContain("0.965 0.972 0.98 rg");
    expect(document).toContain("0.11 0.13 0.17 rg");
    expect(document).toContain("(Summarize the release.) Tj");
    expect(document).toContain("(Release notes) Tj");
    expect(document).toContain("(Ship) Tj");
    expect(document).toContain("(Keep docs \\(https://example.invalid/docs\\)) Tj");
    expect(document).toContain("(const total = 1 + 1;) Tj");
    expect(document).toContain("Page 1 of 1");
  });

  it("keeps CJK text extractable through the predefined CID font", () => {
    const bytes = buildChatPdf(
      input([
        {
          speaker: "Lam",
          role: "user",
          timestampIso: null,
          body: "请把发布说明整理成中文摘要。",
          attachments: 0,
        },
      ]),
    );
    const document = pdfText(bytes);
    expect(document).toContain("/BaseFont /STSong-Light");
    expect(document).toContain("/Encoding /UniGB-UCS2-H");
    const hex = Array.from("请把发布说明整理成中文摘要。")
      .map((char) => char.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0"))
      .join("");
    expect(document).toContain(hex);
  });

  it("paginates long transcripts, marks continuation, and never drops content", () => {
    const longCode = Array.from({ length: 220 }, (_, index) => `line ${index} keeps its body`).join(
      "\n",
    );
    const bytes = buildChatPdf(
      input([
        {
          speaker: "You",
          role: "user",
          timestampIso: null,
          body: "Run the checklist.",
          attachments: 0,
        },
        {
          speaker: "AgileClaw",
          role: "assistant",
          timestampIso: null,
          body: longCode,
          attachments: 0,
        },
      ]),
    );
    const document = pdfText(bytes);
    const pages = pagesOf(document);
    expect(pages).toBeGreaterThan(1);
    expect(document.match(/\/Type \/Page /gu)?.length).toBe(pages);
    expect(document).toContain("(continued) Tj");
    for (const index of [0, 120, 219]) {
      expect(document).toContain(`(line ${index} keeps its body) Tj`);
    }
    expect(document).toContain("Page 1 of");
  });

  it("breaks a long unbreakable token across lines instead of clipping it", () => {
    const token = "a".repeat(400);
    const document = pdfText(
      buildChatPdf(
        input([{ speaker: "You", role: "user", timestampIso: null, body: token, attachments: 0 }]),
      ),
    );
    const fragments = [...document.matchAll(/\((a+)\) Tj/gu)].map((match) => match[1]);
    expect(fragments.length).toBeGreaterThan(1);
    expect(fragments.join("")).toBe(token);
  });

  it("reports a transcript that exceeds the page budget instead of truncating it", () => {
    const entries: ChatPdfInput["entries"] = [];
    for (let index = 0; index < 1200; index += 1) {
      const rows: string[] = [];
      for (let row = 0; row < 30; row += 1) {
        rows.push(`row ${index}-${row}`);
      }
      entries.push({
        speaker: "AgileClaw",
        role: "assistant",
        timestampIso: null,
        body: rows.join("\n"),
        attachments: 0,
      });
    }
    expect(() => buildChatPdf(input(entries))).toThrow(ChatPdfTooLargeError);
  });

  it("keeps code indentation instead of treating it as droppable leading space", () => {
    const document = pdfText(
      buildChatPdf(
        input([
          {
            speaker: "AgileClaw",
            role: "assistant",
            timestampIso: null,
            body: "```ts\n  indented()\n```",
            attachments: 0,
          },
        ]),
      ),
    );
    expect(document).toContain("(\\240\\240indented\\(\\)) Tj");
  });

  it("wraps a long speaker name instead of clipping it or the timestamp", () => {
    const speaker = "W".repeat(100);
    const document = pdfText(
      buildChatPdf(
        input([
          {
            speaker,
            role: "user",
            timestampIso: "2026-11-17T09:00:00.000Z",
            body: "Body stays inside the page.",
            attachments: 0,
          },
        ]),
      ),
    );
    const speakerRuns = [...document.matchAll(/\((W+)\) Tj/gu)].map((match) => match[1]);
    // A single header run would run past the right margin; wrapping splits it.
    expect(speakerRuns.length).toBeGreaterThan(1);
    expect(speakerRuns.join("")).toBe(speaker);
    expect(document).toContain("(2026-11-17T09:00:00.000Z) Tj");
  });

  it("renders an unsupported character as the explained marker", () => {
    const document = pdfText(
      buildChatPdf({
        ...input([
          {
            speaker: "You",
            role: "user",
            timestampIso: null,
            body: "Emoji: \u{1F99E}",
            attachments: 0,
          },
        ]),
        unsupportedCharacters: 1,
      }),
    );
    expect(document).toContain("<25A1> Tj");
    expect(document).toContain("1 characters outside the PDF font range appear as");
  });

  it("notes attachments without inventing body text", () => {
    const document = pdfText(
      buildChatPdf(
        input([
          {
            speaker: "You",
            role: "user",
            timestampIso: null,
            body: "",
            attachments: 2,
          },
        ]),
      ),
    );
    expect(document).toContain("(Attachments are not included in this export.) Tj");
  });
});

describe("markdownToPdfBlocks", () => {
  it("flattens headings, emphasis, lists, quotes, code, tables, and links", () => {
    const blocks = markdownToPdfBlocks(
      [
        "### Heading",
        "",
        "Plain **bold** and *italic* and `code`.",
        "",
        "1. first",
        "2. second",
        "",
        "> quoted",
        "",
        "| a | b |",
        "| - | - |",
        "| 1 | 2 |",
        "",
        "```",
        "fenced()",
        "```",
        "",
        "---",
      ].join("\n"),
    );
    expect(blocks.map((block) => block.kind)).toEqual([
      "heading",
      "paragraph",
      "listItem",
      "listItem",
      "paragraph",
      "paragraph",
      "paragraph",
      "code",
      "rule",
    ]);
    const paragraph = blocks[1];
    expect(paragraph?.kind === "paragraph" && paragraph.spans.map((span) => span.text)).toEqual([
      "Plain ",
      "bold",
      " and ",
      "italic",
      " and ",
      "code",
      ".",
    ]);
    expect(
      paragraph?.kind === "paragraph" &&
        paragraph.spans.find((span) => span.text === "bold")?.style,
    ).toMatchObject({ bold: true });
    expect(
      paragraph?.kind === "paragraph" &&
        paragraph.spans.find((span) => span.text === "code")?.style,
    ).toMatchObject({ code: true });
    const quote = blocks[4];
    expect(quote?.kind === "paragraph" && quote.quote).toBe(true);
  });

  it("keeps authored ordered-list start numbers, including nested lists", () => {
    const blocks = markdownToPdfBlocks("5. fifth\n6. sixth\n\n   7. nested\n   8. nested next");
    const markers = blocks
      .filter((block) => block.kind === "listItem")
      .map((block) => (block.kind === "listItem" ? block.marker : ""));
    expect(markers).toEqual(["5.", "6.", "7.", "8."]);
  });

  it("keeps raw HTML as inert text", () => {
    const blocks = markdownToPdfBlocks('<script>alert("x")</script>\n\nnormal body');
    const text = JSON.stringify(blocks);
    expect(text).not.toContain("<script>");
    expect(text).toContain("normal body");
  });
});
