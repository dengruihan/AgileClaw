import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { SessionFileOfficePreviewSchema } from "../../../packages/gateway-protocol/src/schema/office-preview.js";
import { parseOfficePreviewBuffer } from "./office-preview-parse.js";
import {
  buildDocxFixture,
  buildRepeatedImageDocxFixture,
  buildStyledDocxFixture,
  textBoxDocxBody,
} from "./office-preview.test-support.js";

type Preview = NonNullable<ReturnType<typeof parseOfficePreviewBuffer>>;
type Paragraph = Extract<
  NonNullable<Preview["pages"]>[number]["blocks"][number],
  { kind: "paragraph" }
>;
type Table = Extract<NonNullable<Preview["pages"]>[number]["blocks"][number], { kind: "table" }>;
type DocxImage = Extract<
  NonNullable<Preview["pages"]>[number]["blocks"][number],
  { kind: "image" }
>;

function paragraphs(preview: Preview, pageIndex: number): Paragraph[] {
  return (preview.pages?.[pageIndex]?.blocks ?? []).filter(
    (block): block is Paragraph => block.kind === "paragraph",
  );
}

function paragraphByText(preview: Preview, text: string): Paragraph | undefined {
  return preview.pages
    ?.flatMap((page) => page.blocks)
    .find((block): block is Paragraph => block.kind === "paragraph" && block.text === text);
}

function tableOn(preview: Preview, pageIndex: number): Table | undefined {
  return preview.pages?.[pageIndex]?.blocks.find((block): block is Table => block.kind === "table");
}

describe("styled document layout", () => {
  it("keeps pages, resolved styles, numbering, tables, and safe images", async () => {
    const preview = parseOfficePreviewBuffer(await buildStyledDocxFixture(), "docx");

    expect(Value.Check(SessionFileOfficePreviewSchema, preview)).toBe(true);
    expect(preview?.format).toBe("docx");
    expect(preview?.pages).toHaveLength(3);

    const firstPage = preview?.pages?.[0];
    // A4 portrait with 1-inch margins, in points.
    expect(firstPage).toMatchObject({
      widthPt: 595.3,
      heightPt: 841.9,
      marginTopPt: 72,
      marginRightPt: 72,
      marginBottomPt: 72,
      marginLeftPt: 72,
    });
    expect(firstPage?.header?.[0]?.text).toBe("Confidential");
    expect(firstPage?.footer?.[0]?.text).toBe("Page footer");

    const title = paragraphByText(preview as Preview, "Quarterly Layout");
    expect(title).toMatchObject({
      role: "title",
      alignment: "center",
      spaceBeforePt: 12,
      spaceAfterPt: 6,
    });
    expect(title?.runs[0]).toMatchObject({
      bold: true,
      fontName: "Georgia",
      fontSizePt: 24,
      color: "#1f3864",
    });

    const body = paragraphByText(preview as Preview, "Plain bold red strong italic theme font");
    expect(body?.runs).toEqual([
      { text: "Plain ", fontSizePt: 11, fontName: "Calibri", color: "#000000" },
      {
        text: "bold red",
        bold: true,
        fontSizePt: 11,
        fontName: "Calibri",
        color: "#ff0000",
      },
      {
        text: " strong italic",
        bold: true,
        italic: true,
        fontSizePt: 11,
        fontName: "Calibri",
        color: "#000000",
      },
      // The run declares only `w:asciiTheme="minorHAnsi"`.
      { text: " theme font", fontSizePt: 11, fontName: "Aptos", color: "#000000" },
    ]);

    const heading = paragraphByText(preview as Preview, "Section Two");
    expect(heading).toMatchObject({ role: "heading", level: 2 });
    expect(heading?.runs[0]).toMatchObject({ bold: true, fontSizePt: 14 });

    expect(paragraphByText(preview as Preview, "First numbered")?.listMarker).toBe("1.");
    expect(paragraphByText(preview as Preview, "Second numbered")?.listMarker).toBe("2.");

    const table = tableOn(preview as Preview, 0);
    expect(table?.columnWidthsPt).toEqual([150, 150]);
    expect(table?.border?.top).toEqual({ style: "thin" });
    expect(table?.rows).toHaveLength(3);
    expect(table?.rows[0]?.cells[0]).toMatchObject({
      shading: "#d9e2f3",
      border: { top: { style: "thin" }, bottom: { style: "thin" } },
    });
    // The continuation row extends the restart cell instead of adding a cell.
    expect(table?.rows[1]?.cells[0]).toMatchObject({ rowSpan: 2 });
    expect(table?.rows[1]?.cells[0]?.paragraphs[0]?.text).toBe("Merged");

    const images = (firstPage?.blocks ?? []).filter(
      (block): block is DocxImage => block.kind === "image",
    );
    expect(images).toHaveLength(1);
    // Images are referenced through the deduplicated media table.
    expect(images[0]).toMatchObject({ widthPt: 75, heightPt: 75, alt: "Synthetic logo" });
    expect(images[0]?.media).toBe(0);
    expect(preview?.media).toHaveLength(1);
    expect(preview?.media?.[0]?.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("splits approximate pages at manual and last-rendered breaks", async () => {
    const preview = parseOfficePreviewBuffer(await buildStyledDocxFixture(), "docx");
    expect(paragraphs(preview as Preview, 1).map((paragraph) => paragraph.text)).toEqual([
      "Page two text",
      "Split before",
    ]);
    expect(paragraphs(preview as Preview, 2).map((paragraph) => paragraph.text)).toEqual([
      "after break",
    ]);
  });

  it("reports every unsupported feature instead of dropping it silently", async () => {
    const preview = parseOfficePreviewBuffer(await buildStyledDocxFixture(), "docx");
    expect(preview?.omitted).toEqual([
      { feature: "exactPagination", count: 0 },
      { feature: "images", count: 1 },
      { feature: "charts", count: 1 },
      { feature: "floatingObjects", count: 1 },
      { feature: "equations", count: 1 },
    ]);
    // No raw text from the floating text box leaks into the body blocks.
    expect(JSON.stringify(preview?.pages)).not.toContain("Floating note");
  });

  it("keeps the legacy text blocks for existing readers", async () => {
    const preview = parseOfficePreviewBuffer(await buildStyledDocxFixture(), "docx");
    expect(preview?.blocks?.slice(0, 3)).toEqual([
      { kind: "heading", level: 1, text: "Quarterly Layout" },
      { kind: "paragraph", text: "Plain bold red strong italic theme font" },
      { kind: "heading", level: 2, text: "Section Two" },
    ]);
    expect(preview?.blocks?.filter((block) => block.kind === "listItem")).toEqual([
      { kind: "listItem", text: "First numbered" },
      { kind: "listItem", text: "Second numbered" },
    ]);
  });

  it("keeps table-cell text in the legacy stream in document order", async () => {
    const preview = parseOfficePreviewBuffer(await buildStyledDocxFixture(), "docx");
    const texts = (preview?.blocks ?? []).map((block) => block.text);
    const expectedOrder = [
      "Section Two",
      "Header A",
      "Header B",
      "Merged",
      "B2",
      "B3",
      "Page two text",
    ];
    const positions = expectedOrder.map((text) => texts.indexOf(text));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions.toSorted((left, right) => left - right)).toEqual(positions);
  });

  it("bounds legacy block text and page runs with the document character budget", async () => {
    const chunk = "x".repeat(8_000);
    const body = Array.from({ length: 60 }, () => `<w:p><w:r><w:t>${chunk}</w:t></w:r></w:p>`).join(
      "",
    );
    const preview = parseOfficePreviewBuffer(await buildDocxFixture(body), "docx");

    const legacyChars = (preview?.blocks ?? []).reduce(
      (total, block) => total + block.text.length,
      0,
    );
    expect(preview?.blocks).toHaveLength(50);
    expect(legacyChars).toBe(400_000);
    const runChars =
      preview?.pages?.flatMap((page) =>
        page.blocks.flatMap((block) =>
          block.kind === "paragraph"
            ? block.runs.map((run) => run.text.length)
            : block.kind === "table"
              ? block.rows.flatMap((row) =>
                  row.cells.flatMap((cell) =>
                    cell.paragraphs.flatMap((paragraph) =>
                      paragraph.runs.map((run) => run.text.length),
                    ),
                  ),
                )
              : [],
        ),
      ) ?? [];
    expect(runChars.reduce((total, length) => total + length, 0)).toBeLessThanOrEqual(400_000);
    expect(preview?.truncated).toBe(true);
  });

  it("deduplicates repeated images instead of repeating their bytes", async () => {
    const preview = parseOfficePreviewBuffer(
      await buildRepeatedImageDocxFixture({ imageBytes: 204_870, occurrences: 10 }),
      "docx",
    );

    expect(Value.Check(SessionFileOfficePreviewSchema, preview)).toBe(true);
    const imageBlocks =
      preview?.pages?.flatMap((page) =>
        page.blocks.filter((block): block is DocxImage => block.kind === "image"),
      ) ?? [];
    expect(imageBlocks).toHaveLength(10);
    expect(preview?.media).toHaveLength(1);
    expect(new Set(imageBlocks.map((block) => block.media)).size).toBe(1);
    // One ~273 k-character data URL plus ten tiny references, not ten copies.
    expect(Buffer.byteLength(JSON.stringify(preview))).toBeLessThan(320_000);
  });

  it("keeps serialized size flat as repeated image occurrences grow", async () => {
    const many = parseOfficePreviewBuffer(
      await buildRepeatedImageDocxFixture({ imageBytes: 204_870, occurrences: 200 }),
      "docx",
    );
    const imageBlocks =
      many?.pages?.flatMap((page) =>
        page.blocks.filter((block): block is DocxImage => block.kind === "image"),
      ) ?? [];
    expect(imageBlocks).toHaveLength(200);
    expect(many?.media).toHaveLength(1);
    // 200 references add only block overhead, not 200 data URLs.
    expect(Buffer.byteLength(JSON.stringify(many))).toBeLessThan(350_000);
  });

  it.each(["inline", "anchor", "vml"] as const)(
    "reports a %s text box instead of dropping its content silently",
    async (form) => {
      const preview = parseOfficePreviewBuffer(
        await buildDocxFixture(textBoxDocxBody({ text: "TEXT_BOX_NOTE", form })),
        "docx",
      );

      expect(Value.Check(SessionFileOfficePreviewSchema, preview)).toBe(true);
      // Content is not silently invented into the body; the approximation is counted.
      expect(JSON.stringify(preview?.pages)).not.toContain("TEXT_BOX_NOTE");
      expect(preview?.omitted).toContainEqual({ feature: "floatingObjects", count: 1 });
    },
  );

  it("bounds approximate pages and reports the cut", async () => {
    const body = Array.from(
      { length: 60 },
      (_, index) =>
        `<w:p><w:r><w:t>Page ${index + 1}</w:t></w:r></w:p><w:p><w:r><w:br w:type="page"/></w:r></w:p>`,
    ).join("");
    const preview = parseOfficePreviewBuffer(await buildDocxFixture(body), "docx");

    expect(Value.Check(SessionFileOfficePreviewSchema, preview)).toBe(true);
    expect(preview?.pages).toHaveLength(50);
    expect(preview?.truncated).toBe(true);
    // The bounded legacy text list keeps its own, larger limit.
    expect(preview?.blocks).toHaveLength(60);
  });

  it("never reads image parts behind external relationships", async () => {
    const body = `<w:p><w:r><w:drawing><wp:inline><wp:extent cx="952500" cy="952500"/><wp:docPr id="9" name="External" descr="External image"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:blipFill><a:blip r:embed="rIdExternal"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
    const preview = parseOfficePreviewBuffer(
      await buildDocxFixture(body, {
        documentRelationships: [
          {
            id: "rIdExternal",
            type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image",
            target: "/hidden/external.png",
            targetMode: "External",
          },
        ],
        extraParts: [
          {
            path: "hidden/external.png",
            content: Buffer.from("EXTERNAL_DOCX_IMAGE_SECRET"),
          },
        ],
      }),
      "docx",
    );

    expect(Value.Check(SessionFileOfficePreviewSchema, preview)).toBe(true);
    expect(JSON.stringify(preview)).not.toContain("EXTERNAL_DOCX_IMAGE_SECRET");
    // The paragraph held only the unresolved image, so no page card is produced.
    expect(preview?.pages).toEqual([]);
    expect(preview?.omitted).toContainEqual({ feature: "images", count: 1 });
  });

  it("reports extra document sections as an approximation notice", async () => {
    const body = `<w:p><w:r><w:t>First section</w:t></w:r></w:p>
<w:p><w:pPr><w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:pPr></w:p>
<w:p><w:r><w:t>Second section</w:t></w:r></w:p>
<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>`;
    const preview = parseOfficePreviewBuffer(await buildDocxFixture(body), "docx");

    expect(Value.Check(SessionFileOfficePreviewSchema, preview)).toBe(true);
    expect(preview?.omitted).toEqual(
      expect.arrayContaining([
        { feature: "multipleSections", count: 1 },
        { feature: "exactPagination", count: 0 },
      ]),
    );
    // Page cards use the final section geometry.
    expect(preview?.pages?.[0]).toMatchObject({ widthPt: 612, heightPt: 792 });
  });

  it("keeps a document without a package body renderable", async () => {
    const preview = parseOfficePreviewBuffer(await buildDocxFixture(""), "docx");
    expect(preview?.pages).toEqual([]);
    expect(preview?.blocks).toEqual([]);
    expect(preview?.omitted).toEqual([{ feature: "exactPagination", count: 0 }]);
  });
});
