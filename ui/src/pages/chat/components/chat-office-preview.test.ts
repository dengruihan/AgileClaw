/* @vitest-environment jsdom */

import { afterEach, expect, it } from "vitest";
import type { SessionFileOfficePreview } from "../../../../../packages/gateway-protocol/src/schema/sessions.js";
import type { SidebarContent } from "./chat-sidebar-content-types.ts";
import "./chat-detail-panel.ts";

type DetailPanel = HTMLElement & {
  content: Extract<SidebarContent, { kind: "office" }>;
  updateComplete: Promise<unknown>;
};

const ONE_PIXEL_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function mountOffice(
  content: Partial<Extract<SidebarContent, { kind: "office" }>> & {
    preview: SessionFileOfficePreview;
  },
) {
  const panel = document.createElement("openclaw-chat-detail-panel") as DetailPanel;
  panel.content = { kind: "office", title: "budget.xlsx", ...content };
  document.body.append(panel);
  await panel.updateComplete;
  await expect
    .poll(() => panel.querySelector("openclaw-chat-office-preview")?.children.length ?? 0)
    .toBeGreaterThan(0);
  return panel;
}

afterEach(() => {
  document.body.replaceChildren();
});

it("renders workbook rows and switches worksheets", async () => {
  const panel = await mountOffice({
    preview: {
      format: "xlsx",
      sheets: [
        {
          name: "Budget",
          rows: [
            ["Item", "Cost"],
            ["Rent", "1200"],
          ],
          rowNumbers: [1, 3],
          rowCount: 3,
          columnCount: 2,
        },
        { name: "Notes", rows: [["Hello"]], rowCount: 1, columnCount: 1 },
        { name: "Hidden", hidden: true, rows: [["Secret"]], rowCount: 1, columnCount: 1 },
      ],
    },
  });

  const viewer = panel.querySelector("openclaw-chat-office-preview")!;
  expect(viewer.querySelector("table")?.textContent).toContain("Rent");
  // Sparse worksheets keep their real row numbers instead of renumbering.
  expect(
    [...viewer.querySelectorAll(".sidebar-office-sheet__row-header")].map((cell) =>
      cell.textContent?.trim(),
    ),
  ).toEqual(["1", "3"]);
  const tabs = [...viewer.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  // Hidden worksheets stay in the payload but are not switchable tabs.
  expect(tabs.map((tab) => tab.textContent?.trim())).toEqual(["Budget", "Notes"]);
  expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");

  tabs[1]?.click();
  await panel.updateComplete;
  await viewer.updateComplete;

  expect(viewer.querySelector("table")?.textContent).toContain("Hello");
  expect(tabs[1]?.getAttribute("aria-selected")).toBe("true");
});

it("renders workbook geometry, merges, styles, and frozen panes", async () => {
  const panel = await mountOffice({
    preview: {
      format: "xlsx",
      omitted: [{ feature: "charts", count: 1 }],
      sheets: [
        {
          name: "Budget",
          rowCount: 2,
          columnCount: 3,
          rowNumbers: [1, 2],
          rows: [
            ["Total", "$1,200.50", "15/01/2024"],
            ["Plain", "Kept", ""],
          ],
          rowHeights: [24, 0],
          columns: [{ width: 30 }, { width: 16 }, { width: 16 }],
          frozenRows: 1,
          frozenColumns: 1,
          mergedCells: [{ row: 0, column: 0, rowSpan: 1, columnSpan: 2 }],
          cells: [
            { row: 0, column: 0, style: 0 },
            { row: 0, column: 2, style: 1 },
            { row: 1, column: 0, plain: true },
          ],
          styles: [
            {
              bold: true,
              fill: "#1f3864",
              color: "#ffffff",
              horizontal: "center",
              vertical: "middle",
              border: { top: { style: "thin" }, bottom: { style: "double" } },
            },
            { italic: true, numberFormat: "dd/mm/yyyy" },
          ],
          defaultStyle: 0,
        },
      ],
    },
  });

  const viewer = panel.querySelector("openclaw-chat-office-preview")!;
  expect(viewer.querySelector(".sidebar-office-preview__omitted")?.textContent).toContain("Charts");
  expect(
    [...viewer.querySelectorAll(".sidebar-office-sheet__column-header")].map((cell) =>
      cell.textContent?.trim(),
    ),
  ).toEqual(["A", "B", "C"]);

  // 30 Excel character units is about 215 CSS pixels, not 30px.
  const colgroup = [...viewer.querySelectorAll("colgroup col")];
  expect((colgroup[1] as HTMLElement).style.width).toBe("215px");
  expect((colgroup[2] as HTMLElement).style.width).toBe("117px");

  const headerRow = viewer.querySelector("tbody tr") as HTMLElement;
  expect(headerRow.style.height).toBe("32px");

  const merged = viewer.querySelector('td[colspan="2"]') as HTMLElement;
  expect(merged?.textContent).toContain("Total");
  expect(merged.style.fontWeight).toBe("700");
  expect(merged.style.textAlign).toBe("center");
  expect(merged.style.borderBottom).toContain("double");
  expect(merged.classList.contains("sidebar-office-sheet__cell--frozen-row")).toBe(true);
  expect(merged.classList.contains("sidebar-office-sheet__cell--frozen-column")).toBe(true);
  expect(merged.style.top).toBe("20px");
  expect(merged.style.left).toBe("46px");

  const plain = viewer.querySelector('td[data-row="1"][data-column="0"]') as HTMLElement;
  // `plain: true` clears the styled sheet default instead of inheriting it.
  expect(plain.style.backgroundColor).toBe("");
  expect(plain.style.fontWeight).toBe("");

  const styledDate = viewer.querySelector('td[data-row="0"][data-column="2"]') as HTMLElement;
  expect(styledDate.textContent).toContain("15/01/2024");
  expect(styledDate.style.fontStyle).toBe("italic");
  expect(styledDate.style.top).toBe("20px");
  expect(styledDate.style.left).toBe("");
});

it("renders document headings, paragraphs, and list items", async () => {
  const panel = await mountOffice({
    title: "report.docx",
    preview: {
      format: "docx",
      blocks: [
        { kind: "heading", level: 2, text: "Quarterly report" },
        { kind: "paragraph", text: "Revenue grew" },
        { kind: "listItem", text: "First point" },
        { kind: "listItem", text: "Second point" },
      ],
    },
  });

  const viewer = panel.querySelector("openclaw-chat-office-preview")!;
  expect(viewer.querySelector('[role="heading"]')?.getAttribute("aria-level")).toBe("2");
  expect(viewer.querySelectorAll("ul li")).toHaveLength(2);
  expect(viewer.textContent).toContain("Revenue grew");
});

it("renders approximate Word pages with styles, tables, media, and notices", async () => {
  const panel = await mountOffice({
    title: "report.docx",
    preview: {
      format: "docx",
      truncated: true,
      header: [
        { kind: "paragraph", role: "body", text: "Confidential", runs: [{ text: "Confidential" }] },
      ],
      footer: [
        { kind: "paragraph", role: "body", text: "Page footer", runs: [{ text: "Page footer" }] },
      ],
      omitted: [
        { feature: "exactPagination", count: 0 },
        { feature: "charts", count: 1 },
        { feature: "multipleSections", count: 1 },
      ],
      media: [{ dataUrl: ONE_PIXEL_PNG }],
      pages: [
        {
          widthPt: 595.3,
          heightPt: 841.9,
          marginTopPt: 72,
          marginRightPt: 72,
          marginBottomPt: 72,
          marginLeftPt: 72,
          blocks: [
            {
              kind: "paragraph",
              role: "title",
              text: "Quarterly Layout",
              alignment: "center",
              spaceBeforePt: 12,
              spaceAfterPt: 6,
              runs: [
                {
                  text: "Quarterly Layout",
                  bold: true,
                  fontName: "Georgia",
                  fontSizePt: 24,
                  color: "#1f3864",
                },
              ],
            },
            {
              kind: "paragraph",
              role: "body",
              text: "Plain bold red strong",
              runs: [
                { text: "Plain ", fontSizePt: 11, color: "#000000" },
                { text: "bold red", bold: true, fontSizePt: 11, color: "#ff0000" },
              ],
            },
            {
              kind: "paragraph",
              role: "listItem",
              level: 1,
              listMarker: "1.",
              text: "First numbered",
              runs: [{ text: "First numbered", fontSizePt: 11 }],
            },
            {
              kind: "table",
              columnWidthsPt: [150, 150],
              border: { top: { style: "thin" } },
              rows: [
                {
                  cells: [
                    {
                      columnSpan: 2,
                      shading: "#d9e2f3",
                      paragraphs: [
                        {
                          kind: "paragraph",
                          role: "body",
                          text: "Merged",
                          runs: [{ text: "Merged", bold: true }],
                        },
                      ],
                    },
                  ],
                },
                {
                  cells: [
                    {
                      rowSpan: 2,
                      paragraphs: [
                        {
                          kind: "paragraph",
                          role: "body",
                          text: "Merged",
                          runs: [{ text: "Merged" }],
                        },
                      ],
                    },
                    {
                      paragraphs: [
                        {
                          kind: "paragraph",
                          role: "body",
                          text: "Right",
                          runs: [{ text: "Right" }],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
            { kind: "image", media: 0, widthPt: 75, heightPt: 75, alt: "Synthetic logo" },
          ],
        },
        {
          widthPt: 595.3,
          heightPt: 841.9,
          marginTopPt: 72,
          marginRightPt: 72,
          marginBottomPt: 72,
          marginLeftPt: 72,
          blocks: [
            {
              kind: "paragraph",
              role: "body",
              text: "Second page",
              runs: [{ text: "Second page", fontSizePt: 11 }],
            },
          ],
        },
      ],
    },
  });

  const viewer = panel.querySelector("openclaw-chat-office-preview")!;
  const pages = [...viewer.querySelectorAll<HTMLElement>(".sidebar-office-docx__page")];
  expect(pages).toHaveLength(2);
  // A4 width in points converts to the browser's 794px page card.
  expect(pages[0]?.style.getPropertyValue("--office-doc-page-width")).toBe("794px");
  expect(pages[0]?.style.paddingTop).toBe("12.095%");
  expect(pages[0]?.style.paddingLeft).toBe("12.095%");

  // The document-level header and footer are shown on every page card.
  expect(viewer.querySelectorAll(".sidebar-office-docx__page-header")).toHaveLength(2);
  expect(viewer.querySelectorAll(".sidebar-office-docx__page-footer")).toHaveLength(2);
  expect(
    [...viewer.querySelectorAll(".sidebar-office-docx__page-header")].map((entry) =>
      entry.textContent?.trim(),
    ),
  ).toEqual(["Confidential", "Confidential"]);

  const title = viewer.querySelector<HTMLElement>('[data-role="title"]')!;
  expect(title.style.textAlign).toBe("center");
  expect(title.style.marginTop).toBe("16px");
  const titleRun = title.querySelector<HTMLElement>(".sidebar-office-docx__run")!;
  expect(titleRun.style.fontWeight).toBe("700");
  expect(titleRun.style.fontSize).toBe("24pt");
  expect(titleRun.style.fontFamily).toContain("Georgia");
  expect(titleRun.style.color).toBeTruthy();

  const redRun = [...viewer.querySelectorAll<HTMLElement>(".sidebar-office-docx__run")].find(
    (run) => run.textContent === "bold red",
  )!;
  expect(redRun.style.fontWeight).toBe("700");
  expect(redRun.style.fontSize).toBe("11pt");

  expect(viewer.querySelector(".sidebar-office-docx__list-marker")?.textContent?.trim()).toBe("1.");

  const table = viewer.querySelector<HTMLElement>(".sidebar-office-docx__table")!;
  expect(table.style.borderTop).toContain("solid");
  const tableCols = [...table.querySelectorAll("col")];
  expect(tableCols).toHaveLength(2);
  expect((tableCols[0] as HTMLElement).style.width).toBe("50%");
  const mergedCell = table.querySelector<HTMLElement>('td[colspan="2"]')!;
  expect(mergedCell.style.backgroundColor).toBeTruthy();
  expect(table.querySelector('td[rowspan="2"]')).not.toBeNull();

  const image = viewer.querySelector<HTMLImageElement>(".sidebar-office-docx__image")!;
  expect(image.src).toBe(ONE_PIXEL_PNG);
  expect(image.alt).toBe("Synthetic logo");
  expect(image.style.width).toBe("100px");

  expect(viewer.querySelector(".sidebar-office-preview__approximation")?.textContent).toContain(
    "Pages approximate",
  );
  expect(viewer.querySelector(".sidebar-office-preview__omitted")?.textContent).toContain("Charts");
  expect(viewer.querySelector(".sidebar-office-preview__omitted")?.textContent).toContain(
    "Other sections",
  );
  expect(viewer.querySelector(".sidebar-office-preview__notice")?.textContent).toContain(
    "truncated",
  );
});

it("renders slide outlines", async () => {
  const panel = await mountOffice({
    title: "deck.pptx",
    preview: {
      format: "pptx",
      slides: [
        { index: 1, title: "Roadmap", lines: ["Ship previews"] },
        { index: 2, lines: ["No title slide"] },
      ],
    },
  });

  const viewer = panel.querySelector("openclaw-chat-office-preview")!;
  const slides = [...viewer.querySelectorAll("[data-slide-index]")];
  expect(slides).toHaveLength(2);
  expect(slides[0]?.textContent).toContain("Roadmap");
  expect(slides[1]?.textContent).toContain("Slide 2");
});

it("shows truncation and empty states", async () => {
  const truncated = await mountOffice({
    preview: { format: "docx", blocks: [{ kind: "paragraph", text: "Partial" }], truncated: true },
  });
  expect(truncated.textContent).toContain("truncated");

  document.body.replaceChildren();
  const empty = await mountOffice({ preview: { format: "xlsx", sheets: [] } });
  expect(empty.textContent).toContain("no previewable content");
});
