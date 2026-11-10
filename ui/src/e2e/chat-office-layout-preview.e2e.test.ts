// Real-browser proof for the layout-faithful Office viewer in the chat side panel.
import path from "node:path";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  type ControlUiE2eServer,
  canRunPlaywrightChromium,
  controlUiE2eWaitTimeoutMs,
  controlUiSessionUrl,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;

const ONE_PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const ONE_PIXEL_PNG = `data:image/png;base64,${ONE_PIXEL_PNG_BASE64}`;

let artifactDir: string;
let browser: Browser;
let server: ControlUiE2eServer;

beforeEach(() => {
  artifactDir = createControlUiE2eArtifactDir("chat-office-layout-preview");
});

beforeAll(async () => {
  server = await startControlUiE2eServer();
  browser = await chromium.launch({ executablePath: chromiumExecutablePath });
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const fileRoot = "/workspace";
const sessionKey = "agent:main:main";

const pageGeometry = {
  widthPt: 595.3,
  heightPt: 841.9,
  marginTopPt: 72,
  marginRightPt: 72,
  marginBottomPt: 72,
  marginLeftPt: 72,
};

const documentPayload = {
  format: "docx",
  header: [
    { kind: "paragraph", role: "body", text: "Confidential", runs: [{ text: "Confidential" }] },
  ],
  footer: [
    { kind: "paragraph", role: "body", text: "Page footer", runs: [{ text: "Page footer" }] },
  ],
  omitted: [
    { feature: "exactPagination", count: 0 },
    { feature: "charts", count: 1 },
    { feature: "multipleSections", count: 2 },
  ],
  media: [{ dataUrl: ONE_PIXEL_PNG }],
  pages: [
    {
      ...pageGeometry,
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
            {
              text: "bold red",
              bold: true,
              fontSizePt: 11,
              color: "#ff0000",
              underline: true,
            },
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
                  border: { top: { style: "thin" }, bottom: { style: "double" } },
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
      ...pageGeometry,
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
};

const workbookRows = Array.from({ length: 30 }, (_, index) => [
  index === 0 ? "Budget" : index === 1 ? "Plain" : `Row ${index + 1}`,
  index === 1 ? "15/01/2024" : index === 2 ? "$1,200.50" : `${index * 10}`,
  index === 0 ? "Date" : index === 2 ? "Kept" : "",
]);

const workbookPayload = {
  format: "xlsx",
  truncated: true,
  omitted: [
    { feature: "charts", count: 1 },
    { feature: "conditionalFormatting", count: 2 },
  ],
  sheets: [
    {
      name: "Budget",
      rowCount: workbookRows.length,
      columnCount: 3,
      rowNumbers: workbookRows.map((_, index) => index + 1),
      rows: workbookRows,
      rowHeights: [24, 0, 0],
      columns: [{ width: 30 }, { width: 16 }, { width: 16 }],
      frozenRows: 1,
      frozenColumns: 1,
      mergedCells: [{ row: 0, column: 0, rowSpan: 1, columnSpan: 2 }],
      cells: [
        { row: 0, column: 0, style: 0 },
        { row: 0, column: 1, style: 0 },
        { row: 1, column: 0, plain: true },
        { row: 1, column: 1, style: 2 },
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
        { fill: "#fff2cc", bold: true, numberFormat: "#,##0.00", horizontal: "right" },
        { italic: true, numberFormat: "dd/mm/yyyy" },
      ],
      defaultStyle: 1,
    },
    {
      name: "Notes",
      rowCount: 2,
      columnCount: 1,
      rows: [["Renew in March"], ["Ask finance"]],
    },
  ],
};

const frozenRows = Array.from({ length: 60 }, (_, index) => [
  `Row ${index + 1}`,
  `Value ${index + 1}`,
  `C ${index + 1}`,
  `D ${index + 1}`,
]);

const wrappedFrozenRows = frozenRows.map((row, index) =>
  index === 1
    ? ["A long value that wraps across several lines in a narrow frozen cell", ...row.slice(1)]
    : row,
);

const frozenWorkbookPayload = {
  format: "xlsx",
  sheets: [
    {
      name: "Default frozen",
      rowCount: frozenRows.length,
      columnCount: 4,
      rowNumbers: frozenRows.map((_, index) => index + 1),
      rows: frozenRows,
      columns: [{ width: 20 }, { width: 20 }, { width: 20 }, { width: 20 }],
      frozenRows: 3,
      frozenColumns: 2,
    },
    {
      name: "Wrapped frozen",
      rowCount: wrappedFrozenRows.length,
      columnCount: 4,
      rowNumbers: wrappedFrozenRows.map((_, index) => index + 1),
      rows: wrappedFrozenRows,
      columns: [{ width: 10 }, { width: 10 }, { width: 10 }, { width: 10 }],
      frozenRows: 3,
      frozenColumns: 2,
      cells: [{ row: 1, column: 0, style: 0 }],
      styles: [{ wrapText: true }],
    },
    {
      name: "Declared frozen",
      rowCount: frozenRows.length,
      columnCount: 4,
      rowNumbers: frozenRows.map((_, index) => index + 1),
      rows: frozenRows,
      rowHeights: [10, 10, 10],
      columns: [{ width: 20 }, { width: 20 }, { width: 20 }, { width: 20 }],
      frozenRows: 3,
      frozenColumns: 2,
    },
  ],
};

const officeFixtures = [
  {
    name: "layout-report.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    file: { officePreview: documentPayload, previewKind: "office" },
  },
  {
    name: "layout-budget.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    file: { officePreview: workbookPayload, previewKind: "office" },
  },
  {
    name: "frozen.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    file: { officePreview: frozenWorkbookPayload, previewKind: "office" },
  },
] as const;

function officeResponse(name: string, file: Record<string, unknown>) {
  return {
    root: fileRoot,
    sessionKey,
    file: {
      kind: "read",
      missing: false,
      name,
      path: name,
      workspacePath: name,
      size: 4096,
      ...file,
    },
  };
}

function officeResponses() {
  return {
    "sessions.files.list": {
      browser: {
        entries: officeFixtures.map(({ name }) => ({ kind: "file", name, path: name, size: 4096 })),
        path: "",
      },
      files: officeFixtures.map(({ name }) => ({
        kind: "read",
        missing: false,
        name,
        path: name,
        size: 4096,
      })),
      root: fileRoot,
      sessionKey,
    },
    "sessions.files.get": {
      cases: officeFixtures.flatMap(({ name, mimeType, file }) =>
        [name, `${fileRoot}/${name}`].map((requestPath) => ({
          match: { path: requestPath },
          response: officeResponse(name, { mimeType, ...file }),
        })),
      ),
    },
  };
}

async function openRailFile(page: import("playwright").Page, name: string) {
  await openChatSidePanelType(page, "Files");
  const row = page.locator(".chat-workspace-rail__file-name:visible", { hasText: name }).first();
  await row.waitFor({ state: "visible" });
  await row.click();
}

async function installOfficeGateway(page: import("playwright").Page) {
  return installMockGateway(page, {
    featureMethods: ["chat.metadata", "chat.startup", "sessions.diff"],
    methodResponses: officeResponses(),
  });
}

describeControlUiE2e("Control UI layout Office side-panel preview", () => {
  it("renders fitted Word pages with document styles, tables, media, and notices", async () => {
    const context = await browser.newContext({ viewport: { height: 900, width: 1280 } });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(controlUiE2eWaitTimeoutMs);
      await installOfficeGateway(page);
      await page.goto(controlUiSessionUrl(server.baseUrl, sessionKey));
      await openRailFile(page, "layout-report.docx");

      const documentView = page.locator('.sidebar-office-preview[data-office-format="docx"]');
      await documentView.waitFor({ state: "visible" });
      await expect.poll(() => documentView.locator(".sidebar-office-docx__page").count()).toBe(2);

      const firstPage = documentView.locator(".sidebar-office-docx__page").first();
      expect(await firstPage.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(
        "rgb(255, 255, 255)",
      );
      expect(
        await firstPage.evaluate((element) => element.scrollHeight - element.clientHeight),
      ).toBeLessThanOrEqual(1);
      expect(
        await documentView
          .locator(".sidebar-office-docx__page-header")
          .allTextContents()
          .then((values) => values.map((value) => value.trim())),
      ).toEqual(["Confidential", "Confidential"]);
      expect(
        await documentView
          .locator(".sidebar-office-docx__page-footer")
          .allTextContents()
          .then((values) => values.map((value) => value.trim())),
      ).toEqual(["Page footer", "Page footer"]);

      const title = firstPage.locator('[data-role="title"]');
      expect(
        await title.evaluate((element) => {
          const style = getComputedStyle(element);
          return [style.fontSize, style.fontWeight, style.textAlign];
        }),
      ).toEqual(["32px", "700", "center"]);
      const titleRun = title.locator(".sidebar-office-docx__run").first();
      expect(
        await titleRun.evaluate((element) => {
          const style = getComputedStyle(element);
          return [style.color, style.fontFamily];
        }),
      ).toEqual(["rgb(31, 56, 100)", expect.stringContaining("Georgia")]);

      const mergedCell = firstPage.locator('.sidebar-office-docx__table td[colspan="2"]');
      await mergedCell.waitFor();
      expect(
        await mergedCell.evaluate((element) => getComputedStyle(element).backgroundColor),
      ).toBe("rgb(217, 226, 243)");
      expect(await firstPage.locator('.sidebar-office-docx__table td[rowspan="2"]').count()).toBe(
        1,
      );

      const image = firstPage.locator(".sidebar-office-docx__image");
      await image.waitFor();
      expect(
        await image.evaluate(
          (element) =>
            (element as HTMLImageElement).complete &&
            (element as HTMLImageElement).naturalWidth > 0,
        ),
      ).toBe(true);
      expect(await image.getAttribute("alt")).toBe("Synthetic logo");

      await expect
        .poll(() => documentView.locator(".sidebar-office-preview__approximation").textContent())
        .toContain("Pages approximate");
      const omitted = await documentView.locator(".sidebar-office-preview__omitted").textContent();
      expect(omitted).toContain("Charts");
      expect(omitted).toContain("Other sections");

      const overflow = await page
        .locator(".sidebar-content")
        .evaluate((element) => element.scrollWidth - element.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);
      await page.screenshot({ path: path.join(artifactDir, "after-docx-pages-desktop.png") });
    } finally {
      await context.close();
    }
  });

  it("renders a styled workbook with real units, merges, and frozen panes", async () => {
    const context = await browser.newContext({ viewport: { height: 900, width: 1280 } });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(controlUiE2eWaitTimeoutMs);
      await installOfficeGateway(page);
      await page.goto(controlUiSessionUrl(server.baseUrl, sessionKey));
      await openRailFile(page, "layout-budget.xlsx");

      const workbook = page.locator('.sidebar-office-preview[data-office-format="xlsx"]');
      await workbook.waitFor({ state: "visible" });
      await expect
        .poll(() =>
          workbook
            .locator(".sidebar-office-sheet__column-header")
            .allTextContents()
            .then((values) => values.map((value) => value.trim())),
        )
        .toEqual(["A", "B", "C"]);
      expect(
        await workbook.locator(".sidebar-office-sheet__row-header").first().textContent(),
      ).toContain("1");

      const firstColumn = workbook.locator("colgroup col").nth(1);
      expect(await firstColumn.evaluate((element) => getComputedStyle(element).width)).toBe(
        "215px",
      );
      expect(
        await workbook
          .locator('.sidebar-office-sheet__cell[data-row="0"][data-column="2"]')
          .evaluate((element) => getComputedStyle(element).height),
      ).toBe("32px");

      const merged = workbook.locator('.sidebar-office-sheet__cell[colspan="2"]');
      expect(await merged.textContent()).toContain("Budget");
      expect(
        await merged.evaluate((element) => {
          const style = getComputedStyle(element);
          return [style.fontWeight, style.textAlign, style.backgroundColor];
        }),
      ).toEqual(["700", "center", "rgb(31, 56, 100)"]);

      // `plain: true` clears the styled sheet default.
      const plainCell = workbook.locator(
        '.sidebar-office-sheet__cell[data-row="1"][data-column="0"]',
      );
      const plainStyle = await plainCell.evaluate((element) => {
        const style = getComputedStyle(element);
        return [style.backgroundColor, style.fontWeight, style.textAlign];
      });
      // The sheet default fills and bolds cells; `plain: true` clears both.
      expect(plainStyle[0]).not.toBe("rgb(255, 242, 204)");
      expect(plainStyle[1]).toBe("400");
      expect(plainStyle[2]).toBe("left");

      expect(await workbook.textContent()).toContain("15/01/2024");
      expect(await workbook.textContent()).toContain("$1,200.50");
      expect(await workbook.textContent()).toContain("Charts");
      expect(await workbook.textContent()).toContain("truncated");

      await page.screenshot({ path: path.join(artifactDir, "after-xlsx-grid-desktop.png") });

      const scroll = workbook.locator(".sidebar-office-sheet__scroll");
      const columnHeader = workbook.locator(".sidebar-office-sheet__column-header").first();
      const rowHeader = workbook.locator(".sidebar-office-sheet__row-header").first();
      const boxBefore = await columnHeader.boundingBox();
      const rowBoxBefore = await rowHeader.boundingBox();
      await scroll.evaluate((element) => {
        element.scrollTop = 300;
        element.scrollLeft = 120;
      });
      await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(100);
      const boxAfter = await columnHeader.boundingBox();
      const rowBoxAfter = await rowHeader.boundingBox();
      // The column letters stay pinned at the top and the row numbers at the left.
      expect(Math.abs((boxAfter?.y ?? 0) - (boxBefore?.y ?? 0))).toBeLessThanOrEqual(1);
      expect(Math.abs((rowBoxAfter?.x ?? 0) - (rowBoxBefore?.x ?? 0))).toBeLessThanOrEqual(1);
    } finally {
      await context.close();
    }
  });

  it("renders the same workbook layout from the Files-rail artifact entrypoint", async () => {
    const context = await browser.newContext({
      acceptDownloads: true,
      viewport: { height: 900, width: 1280 },
    });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(controlUiE2eWaitTimeoutMs);
      const artifact = {
        id: "artifact_layout_budget",
        type: "file",
        title: "layout-budget.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        sizeBytes: 4096,
        download: { mode: "bytes" },
      };
      const gateway = await installMockGateway(page, {
        featureMethods: ["chat.metadata", "chat.startup", "sessions.diff"],
        methodResponses: {
          ...officeResponses(),
          "artifacts.list": { artifacts: [artifact] },
          "artifacts.download": {
            cases: [
              {
                match: { preview: "office" },
                response: {
                  artifact,
                  preview: {
                    kind: "office",
                    format: "xlsx",
                    state: "ready",
                    preview: workbookPayload,
                  },
                },
              },
              { response: { artifact, encoding: "base64", data: "UEsAAQ==" } },
            ],
          },
        },
      });
      await page.goto(controlUiSessionUrl(server.baseUrl, sessionKey));
      await openChatSidePanelType(page, "Files");
      const artifactsChip = page.locator(".chat-workspace-rail__chip").filter({
        hasText: /artifact/iu,
      });
      await artifactsChip.first().click();
      const row = page
        .locator(".chat-workspace-rail__file-name", { hasText: "layout-budget.xlsx" })
        .first();
      await row.waitFor({ state: "visible" });

      let downloads = 0;
      page.on("download", () => {
        downloads += 1;
      });
      await row.click();
      const workbook = page.locator('.sidebar-office-preview[data-office-format="xlsx"]');
      await workbook.waitFor({ state: "visible" });
      await expect
        .poll(() =>
          workbook
            .locator(".sidebar-office-sheet__column-header")
            .allTextContents()
            .then((values) => values.map((value) => value.trim())),
        )
        .toEqual(["A", "B", "C"]);
      expect(await workbook.locator('.sidebar-office-sheet__cell[colspan="2"]').count()).toBe(1);
      expect(downloads).toBe(0);
      const request = await gateway.waitForRequest("artifacts.download");
      expect(request.params).toMatchObject({ artifactId: artifact.id, preview: "office" });
      expect(await page.locator(".sidebar-office-preview__download").count()).toBe(1);
      await page.screenshot({ path: path.join(artifactDir, "after-artifact-rail-grid.png") });
    } finally {
      await context.close();
    }
  });

  it("keeps multiple frozen rows and their intersections aligned after scrolling", async () => {
    const context = await browser.newContext({ viewport: { height: 900, width: 1280 } });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(controlUiE2eWaitTimeoutMs);
      await installOfficeGateway(page);
      await page.goto(controlUiSessionUrl(server.baseUrl, sessionKey));
      await openRailFile(page, "frozen.xlsx");

      const workbook = page.locator('.sidebar-office-preview[data-office-format="xlsx"]');
      await workbook.waitFor({ state: "visible" });

      const verifyFrozenGeometry = async (label: string, expectTallRow: boolean) => {
        const scroll = workbook.locator(".sidebar-office-sheet__scroll");
        await scroll.evaluate((element) => {
          element.scrollTop = 400;
          element.scrollLeft = 150;
        });
        await expect
          .poll(() => scroll.evaluate((element) => element.scrollTop))
          .toBeGreaterThan(100);

        await page.screenshot({
          path: path.join(artifactDir, `before-assert-frozen-${label}-scroll.png`),
        });
        const boxes = await workbook.locator("tbody tr").evaluateAll((rows) =>
          rows.slice(0, 3).map((row) => {
            const cell = row.querySelector('td[data-column="0"]');
            const rect = (cell ?? row).getBoundingClientRect();
            return { height: rect.height, top: rect.top, bottom: rect.bottom };
          }),
        );
        expect(boxes).toHaveLength(3);
        if (expectTallRow) {
          expect(boxes[1]?.height ?? 0).toBeGreaterThan((boxes[0]?.height ?? 0) + 1);
        }
        // Adjacent frozen rows must tile, not overlap, after the scroll.
        expect(Math.abs((boxes[1]?.top ?? 0) - (boxes[0]?.bottom ?? 0))).toBeLessThanOrEqual(1);
        expect(Math.abs((boxes[2]?.top ?? 0) - (boxes[1]?.bottom ?? 0))).toBeLessThanOrEqual(1);

        const hit = await page.evaluate(() => {
          const cell = document.querySelector(
            '.sidebar-office-sheet__cell[data-row="0"][data-column="0"]',
          );
          if (!cell) {
            return null;
          }
          const rect = cell.getBoundingClientRect();
          const element = document.elementFromPoint(rect.left + rect.width / 2, rect.bottom - 1);
          return element
            ? {
                column: element.getAttribute("data-column"),
                row: element.getAttribute("data-row"),
              }
            : null;
        });
        expect(hit).toMatchObject({ row: "0", column: "0" });
        await page.screenshot({
          path: path.join(artifactDir, `after-frozen-${label}-scroll.png`),
        });
      };

      await verifyFrozenGeometry("default", false);
      await workbook.getByRole("tab", { name: "Wrapped frozen" }).click();
      await expect
        .poll(() => workbook.locator(".sidebar-office-sheet__column-header").first().textContent())
        .toContain("A");
      await verifyFrozenGeometry("wrapped", true);
      await workbook.getByRole("tab", { name: "Declared frozen" }).click();
      await expect
        .poll(() => workbook.locator(".sidebar-office-sheet__column-header").first().textContent())
        .toContain("A");
      await verifyFrozenGeometry("declared", false);
    } finally {
      await context.close();
    }
  });

  it("keeps Word pages and workbook grids readable in a narrow dark sidebar", async () => {
    const context = await browser.newContext({
      colorScheme: "dark",
      viewport: { height: 820, width: 900 },
    });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(controlUiE2eWaitTimeoutMs);
      await installOfficeGateway(page);
      await page.goto(controlUiSessionUrl(server.baseUrl, sessionKey));

      await openRailFile(page, "layout-report.docx");
      const documentView = page.locator('.sidebar-office-preview[data-office-format="docx"]');
      await documentView.waitFor({ state: "visible" });
      const pageCard = documentView.locator(".sidebar-office-docx__page").first();
      await pageCard.waitFor();
      const sidebarWidth = await page
        .locator(".sidebar-content")
        .evaluate((element) => element.clientWidth);
      const cardWidth = await pageCard.evaluate((element) => element.getBoundingClientRect().width);
      expect(cardWidth).toBeLessThanOrEqual(sidebarWidth + 1);
      expect(await pageCard.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(
        "rgb(255, 255, 255)",
      );
      expect(
        await page
          .locator(".sidebar-content")
          .evaluate((element) => element.scrollWidth - element.clientWidth),
      ).toBeLessThanOrEqual(1);
      await page.screenshot({ path: path.join(artifactDir, "after-docx-pages-narrow-dark.png") });

      const workbookContext = await browser.newContext({
        colorScheme: "dark",
        viewport: { height: 820, width: 900 },
      });
      try {
        const workbookPage = await workbookContext.newPage();
        workbookPage.setDefaultTimeout(controlUiE2eWaitTimeoutMs);
        await installOfficeGateway(workbookPage);
        await workbookPage.goto(controlUiSessionUrl(server.baseUrl, sessionKey));
        await openRailFile(workbookPage, "layout-budget.xlsx");
        const workbook = workbookPage.locator('.sidebar-office-preview[data-office-format="xlsx"]');
        await workbook.waitFor({ state: "visible" });
        expect(await workbook.locator(".sidebar-office-sheet__scroll").count()).toBe(1);
        expect(
          await workbookPage
            .locator(".sidebar-content")
            .evaluate((element) => element.scrollWidth - element.clientWidth),
        ).toBeLessThanOrEqual(1);
        await workbookPage.screenshot({
          path: path.join(artifactDir, "after-xlsx-grid-narrow-dark.png"),
        });
      } finally {
        await workbookContext.close();
      }
    } finally {
      await context.close();
    }
  });
});
