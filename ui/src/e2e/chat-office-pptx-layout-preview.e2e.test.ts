// Real-browser proof for fixed slide canvases in the chat side panel.
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

const ONE_PIXEL_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const fileRoot = "/workspace";
const sessionKey = "agent:main:main";
const SLIDE_WIDTH_PT = 960;
const SLIDE_HEIGHT_PT = 540;
/** Declared 16:9 canvas; every slide keeps this ratio at any zoom. */
const SLIDE_RATIO = SLIDE_HEIGHT_PT / SLIDE_WIDTH_PT;
const SLIDE_TEXT =
  "Revenue increased across every region as the new preview pipeline shipped and support volume fell.";

let artifactDir: string;
let browser: Browser;
let server: ControlUiE2eServer;

beforeEach(() => {
  artifactDir = createControlUiE2eArtifactDir("chat-office-pptx-layout-preview");
});

beforeAll(async () => {
  server = await startControlUiE2eServer();
  browser = await chromium.launch({ executablePath: chromiumExecutablePath });
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

function paragraph(text: string, fontSizePt = 18) {
  return { kind: "paragraph" as const, role: "body" as const, text, runs: [{ text, fontSizePt }] };
}

function bullet(text: string) {
  return { ...paragraph(text), role: "listItem" as const, listMarker: "•" };
}

function cell(text: string, extra?: Record<string, unknown>) {
  return { ...extra, paragraphs: [paragraph(text, 14)] };
}

/** Shape geometry mirrors what the Gateway sends for an authored slide. */
const slidesPayload = {
  format: "pptx",
  slideSize: { widthPt: SLIDE_WIDTH_PT, heightPt: SLIDE_HEIGHT_PT },
  omitted: [
    { feature: "charts", count: 1 },
    { feature: "diagrams", count: 1 },
    { feature: "floatingObjects", count: 1 },
  ],
  media: [{ dataUrl: ONE_PIXEL_PNG }],
  slides: [
    {
      index: 1,
      title: "Fixed slide title",
      lines: ["Revenue increased", "Support volume fell"],
      shapes: [
        {
          kind: "shape",
          xPt: 66,
          yPt: 28.8,
          widthPt: 828,
          heightPt: 104.4,
          verticalAnchor: "middle",
          insetTopPt: 3.6,
          insetRightPt: 7.2,
          insetBottomPt: 3.6,
          insetLeftPt: 7.2,
          paragraphs: [
            {
              ...paragraph("Fixed slide title", 44),
              alignment: "center",
              runs: [{ text: "Fixed slide title", bold: true, fontSizePt: 44, color: "#44546a" }],
            },
          ],
        },
        {
          kind: "shape",
          xPt: 66,
          yPt: 160,
          widthPt: 420,
          heightPt: 180,
          preset: "rect",
          insetTopPt: 3.6,
          insetRightPt: 7.2,
          insetBottomPt: 3.6,
          insetLeftPt: 7.2,
          paragraphs: [bullet(SLIDE_TEXT), bullet("Support volume fell")],
        },
        {
          kind: "shape",
          xPt: 520,
          yPt: 160,
          widthPt: 360,
          heightPt: 100,
          preset: "roundRect",
          fill: "#1f3864",
          lineColor: "#44546a",
          lineWidthPt: 2,
          paragraphs: [
            {
              ...paragraph("Adoption climbed"),
              runs: [{ text: "Adoption climbed", fontSizePt: 18, color: "#ffffff" }],
            },
          ],
        },
        {
          kind: "table",
          xPt: 66,
          yPt: 360,
          widthPt: 400,
          heightPt: 120,
          table: {
            kind: "table",
            columnWidthsPt: [200, 200],
            border: { top: { style: "thin" } },
            rows: [
              {
                cells: [
                  cell("Region", {
                    shading: "#d9e2f3",
                    border: { top: { style: "thin", color: "#000000" } },
                  }),
                  cell("Revenue"),
                ],
              },
              { cells: [{ ...cell("Merged total"), columnSpan: 2 }] },
            ],
          },
        },
        { kind: "image", xPt: 780, yPt: 360, widthPt: 100, heightPt: 100, media: 0, alt: "Logo" },
        // Connectors: horizontal, elbow, plain vertical, rotation form, diagonals
        // with and without flipH, and PowerPoint's flat-box + rot form.
        {
          kind: "shape",
          xPt: 500,
          yPt: 280,
          widthPt: 200,
          heightPt: 0,
          preset: "line",
          lineColor: "#4472c4",
          lineWidthPt: 1,
        },
        {
          kind: "shape",
          xPt: 720,
          yPt: 265,
          widthPt: 60,
          heightPt: 70,
          preset: "bentConnector3",
          lineColor: "#ed7d31",
          lineWidthPt: 1,
        },
        {
          kind: "shape",
          xPt: 900,
          yPt: 160,
          widthPt: 0,
          heightPt: 80,
          preset: "line",
          lineColor: "#4472c4",
          lineWidthPt: 1,
        },
        {
          kind: "shape",
          xPt: 900,
          yPt: 300,
          widthPt: 100,
          heightPt: 0,
          preset: "line",
          rotationDeg: 90,
          lineColor: "#4472c4",
          lineWidthPt: 1,
        },
        {
          kind: "shape",
          xPt: 500,
          yPt: 460,
          widthPt: 80,
          heightPt: 60,
          preset: "straightConnector1",
          lineColor: "#4472c4",
          lineWidthPt: 1,
        },
        {
          kind: "shape",
          xPt: 600,
          yPt: 460,
          widthPt: 80,
          heightPt: 60,
          preset: "straightConnector1",
          flipHorizontal: true,
          lineColor: "#4472c4",
          lineWidthPt: 1,
        },
        {
          kind: "shape",
          xPt: 700,
          yPt: 460,
          widthPt: 100,
          heightPt: 0,
          preset: "straightConnector1",
          rotationDeg: 45,
          lineColor: "#4472c4",
          lineWidthPt: 1,
        },
        // PowerPoint's real diagonal form: non-flat box + rot + flips
        // (42x42pt at 90deg with both flips, from the POI slideshow corpus).
        {
          kind: "shape",
          xPt: 180,
          yPt: 174,
          widthPt: 42,
          heightPt: 42,
          preset: "straightConnector1",
          rotationDeg: 90,
          flipHorizontal: true,
          flipVertical: true,
          lineColor: "#4472c4",
          lineWidthPt: 1,
        },
        // 102x36pt at 270deg with flipH (same corpus).
        {
          kind: "shape",
          xPt: 147,
          yPt: 249,
          widthPt: 102,
          heightPt: 36,
          preset: "straightConnector1",
          rotationDeg: 270,
          flipHorizontal: true,
          lineColor: "#ed7d31",
          lineWidthPt: 1,
        },
        {
          kind: "shape",
          xPt: 500,
          yPt: 300,
          widthPt: 180,
          heightPt: 40,
          preset: "roundRect",
          fill: "#fff2cc",
          lineColor: "#bf9000",
          lineWidthPt: 1,
          flipHorizontal: true,
          paragraphs: [
            {
              ...paragraph("Flipped label", 14),
              runs: [{ text: "Flipped label", fontSizePt: 14, color: "#000000" }],
            },
          ],
        },
      ],
    },
    {
      index: 2,
      title: "Closing",
      lines: ["Thank you"],
      background: "#1f3864",
      shapes: [
        {
          kind: "shape",
          xPt: 66,
          yPt: 180,
          widthPt: 828,
          heightPt: 120,
          paragraphs: [
            {
              ...paragraph("Thank you", 32),
              alignment: "center",
              runs: [{ text: "Thank you", fontSizePt: 32, color: "#ffffff" }],
            },
          ],
        },
      ],
    },
  ],
};

const deckName = "layout-deck.pptx";

function officeResponses() {
  const file = {
    kind: "read",
    missing: false,
    name: deckName,
    path: deckName,
    workspacePath: deckName,
    size: 4096,
    mimeType: PPTX_MIME,
    officePreview: slidesPayload,
    previewKind: "office",
  };
  return {
    "sessions.files.list": {
      browser: {
        entries: [{ kind: "file", name: deckName, path: deckName, size: 4096 }],
        path: "",
      },
      files: [{ kind: "read", missing: false, name: deckName, path: deckName, size: 4096 }],
      root: fileRoot,
      sessionKey,
    },
    "sessions.files.get": {
      cases: [deckName, `${fileRoot}/${deckName}`].map((requestPath) => ({
        match: { path: requestPath },
        response: { root: fileRoot, sessionKey, file },
      })),
    },
  };
}

async function installOfficeGateway(page: import("playwright").Page) {
  return installMockGateway(page, {
    featureMethods: ["chat.metadata", "chat.startup", "sessions.diff"],
    methodResponses: officeResponses(),
  });
}

async function openDeck(page: import("playwright").Page) {
  await openChatSidePanelType(page, "Files");
  const row = page
    .locator(".chat-workspace-rail__file-name:visible", { hasText: deckName })
    .first();
  await row.waitFor({ state: "visible" });
  await row.click();
}

/**
 * Resize the side panel the way a user does: drag its divider to the panel
 * width under test, then wait for the reader to report that width.
 */
async function resizeSidePanel(page: import("playwright").Page, width: number) {
  const geometry = await page.evaluate(() => {
    const region = [...document.querySelectorAll<HTMLElement>(".sidebar-region")].find(
      (element) => element.clientWidth > 0,
    );
    const divider = [...document.querySelectorAll<HTMLElement>(".sidebar-column__divider")].find(
      (element) => element.getBoundingClientRect().width > 0,
    );
    if (!region || !divider) {
      return null;
    }
    const dividerRect = divider.getBoundingClientRect();
    return {
      right: region.getBoundingClientRect().right,
      x: dividerRect.left + dividerRect.width / 2,
      y: dividerRect.top + dividerRect.height / 2,
    };
  });
  const { right, x, y } = geometry!;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(right - width, y, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction(
    (target) =>
      [...document.querySelectorAll<HTMLElement>(".sidebar-content")].some(
        (content) => Math.abs(content.clientWidth - target) <= 24,
      ),
    width,
    { timeout: controlUiE2eWaitTimeoutMs },
  );
}

/**
 * Slide geometry probe: the fixed canvas, the applied scale, and every placed
 * shape's unscaled layout box plus each paragraph's layout height. Runs inside
 * the page: keep it self-contained.
 */
function sampleSlideCanvas() {
  const reader = [...document.querySelectorAll<HTMLElement>(".sidebar-office-pptx__scroll")].find(
    (element) => element.clientWidth > 0,
  );
  const slide = reader?.querySelector<HTMLElement>(".sidebar-office-pptx__slide");
  if (!reader || !slide) {
    return null;
  }
  const rect = slide.getBoundingClientRect();
  const style = getComputedStyle(slide);
  const sidebar = document.querySelector<HTMLElement>(".sidebar-content");
  return {
    canvasWidth: Number.parseFloat(style.getPropertyValue("--office-slide-width")),
    canvasHeight: Number.parseFloat(style.getPropertyValue("--office-slide-height")),
    slideCount: reader.querySelectorAll(".sidebar-office-pptx__slide").length,
    slideWidth: rect.width,
    slideHeight: rect.height,
    readerWidth: reader.clientWidth,
    scale: Number.parseFloat(
      getComputedStyle(reader).getPropertyValue("--office-canvas-scale").trim() || "NaN",
    ),
    shapes: [...slide.querySelectorAll<HTMLElement>(".sidebar-office-pptx__shape")].map(
      (shape) => ({
        height: shape.offsetHeight,
        left: shape.style.left,
        top: shape.style.top,
        width: shape.offsetWidth,
      }),
    ),
    paragraphs: [...slide.querySelectorAll<HTMLElement>(".sidebar-office-pptx__paragraph")].map(
      (entry) => entry.offsetHeight,
    ),
    overflowX: reader.scrollWidth - reader.clientWidth,
    sidebarOverflow: sidebar ? sidebar.scrollWidth - sidebar.clientWidth : 0,
    text: reader.textContent ?? "",
  };
}

/** Fit width settles on the reader's new box through the shared zoom owner. */
async function waitForFitScale(page: import("playwright").Page) {
  await expect
    .poll(async () => {
      const state = await page.evaluate(sampleSlideCanvas);
      if (!state) {
        return false;
      }
      const expected =
        Math.round(
          Math.min(4, Math.max(0.25, (state.readerWidth - 8) / state.canvasWidth)) * 1000,
        ) / 1000;
      return Math.abs(state.scale - expected) <= 0.002;
    })
    .toBe(true);
}

/**
 * Connector boxes in unscaled slide pixels plus their rotation angle. Runs
 * inside the page: keep it self-contained.
 */
function sampleConnectors() {
  const reader = [...document.querySelectorAll<HTMLElement>(".sidebar-office-pptx__scroll")].find(
    (element) => element.clientWidth > 0,
  );
  const slide = reader?.querySelector<HTMLElement>(".sidebar-office-pptx__slide");
  if (!slide) {
    return null;
  }
  const slideRect = slide.getBoundingClientRect();
  const scale = slideRect.width / 1280;
  const angleOf = (transform: string): number => {
    if (!transform.startsWith("matrix(")) {
      return 0;
    }
    const [a = 1, b = 0] = transform
      .slice("matrix(".length, -1)
      .split(",")
      .map((value) => Number(value.trim()));
    return (Math.atan2(b, a) * 180) / Math.PI;
  };
  return [...slide.querySelectorAll<HTMLElement>(".sidebar-office-pptx__connector")].map(
    (element) => {
      const rect = element.getBoundingClientRect();
      return {
        left: (rect.left - slideRect.left) / scale,
        top: (rect.top - slideRect.top) / scale,
        width: rect.width / scale,
        height: rect.height / scale,
        angle: angleOf(getComputedStyle(element).transform),
      };
    },
  );
}

describeControlUiE2e("Control UI fixed slide preview", () => {
  it("renders presentation slides on their declared fixed canvas", async () => {
    const context = await browser.newContext({ viewport: { height: 900, width: 1280 } });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(controlUiE2eWaitTimeoutMs);
      await installOfficeGateway(page);
      await page.goto(controlUiSessionUrl(server.baseUrl, sessionKey));
      await openDeck(page);

      const view = page.locator('.sidebar-office-preview[data-office-format="pptx"]');
      await view.waitFor({ state: "visible" });
      // Both renderers answer this selector: a geometry payload keeps the fixed
      // canvas, a geometry-free payload falls back to the explicit text outline.
      await view
        .locator(".sidebar-office-pptx__slide, .sidebar-office-preview__slide")
        .first()
        .waitFor();
      await page.screenshot({ path: path.join(artifactDir, "slides-renderer-step.png") });

      await expect.poll(() => view.locator(".sidebar-office-pptx__slide").count()).toBe(2);
      const firstSlide = view.locator(".sidebar-office-pptx__slide").first();
      const canvas = await firstSlide.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          height: style.getPropertyValue("--office-slide-height").trim(),
          width: style.getPropertyValue("--office-slide-width").trim(),
          shapes: [...element.querySelectorAll<HTMLElement>(".sidebar-office-pptx__shape")].map(
            (shape) => ({
              height: shape.style.height,
              left: shape.style.left,
              top: shape.style.top,
              width: shape.style.width,
            }),
          ),
        };
      });
      // 960x540pt is a 1280x720 CSS pixel canvas; shapes keep their point boxes.
      expect(canvas.width).toBe("1280px");
      expect(canvas.height).toBe("720px");
      expect(canvas.shapes[0]).toEqual({
        left: "88px",
        top: "38.4px",
        width: "1104px",
        height: "139.2px",
      });
      expect(canvas.shapes[1]).toMatchObject({ left: "88px", top: "213.3px", width: "560px" });

      const titleRun = firstSlide.locator(".sidebar-office-pptx__run").first();
      const titleStyle = await titleRun.evaluate((element) => {
        const style = getComputedStyle(element);
        return { color: style.color, fontSize: style.fontSize, fontWeight: style.fontWeight };
      });
      expect(titleStyle.color).toBe("rgb(68, 84, 106)");
      expect(Number.parseFloat(titleStyle.fontSize)).toBeCloseTo(58.67, 1);
      expect(titleStyle.fontWeight).toBe("700");
      // One line of 44pt text: template whitespace must not inflate the box.
      expect(
        await firstSlide
          .locator(".sidebar-office-pptx__paragraph")
          .first()
          .evaluate((element) => (element as HTMLElement).offsetHeight),
      ).toBeLessThan(90);
      expect(await firstSlide.locator(".sidebar-office-pptx__bullet").first().textContent()).toBe(
        "•",
      );
      expect(await firstSlide.locator(".sidebar-office-pptx__table").textContent()).toContain(
        "Merged total",
      );
      const image = firstSlide.locator(".sidebar-office-pptx__image");
      await image.waitFor();
      expect(
        await image.evaluate(
          (element) =>
            (element as HTMLImageElement).complete &&
            (element as HTMLImageElement).naturalWidth > 0,
        ),
      ).toBe(true);
      expect(await image.getAttribute("alt")).toBe("Logo");

      // Connectors draw rules between their authored endpoints, at any angle.
      const connectorBoxes = (await page.evaluate(sampleConnectors))!;
      expect(connectorBoxes).toHaveLength(9);
      // Payload geometry is in points; the canvas lays out CSS pixels at 4/3.
      const pt = (value: number) => (value * 4) / 3;
      const diagonalAngle = (Math.atan2(60, 80) * 180) / Math.PI;
      const expectedConnectors = [
        // horizontal line
        { left: pt(500), top: pt(280) - 0.5, width: pt(200), height: 1, angle: 0 },
        // elbow preset approximates as a center-to-center horizontal segment
        { left: pt(720), top: pt(300) - 0.5, width: pt(60), height: 1, angle: 0 },
        // plain vertical
        { left: pt(900) - 0.5, top: pt(160), width: 1, height: pt(80), angle: 90 },
        // PowerPoint rotation form: centered on the box, vertical at 90deg
        { left: pt(950) - 0.5, top: pt(250), width: 1, height: pt(100), angle: 90 },
        // landscape diagonal
        { left: pt(500), top: pt(460), width: pt(80), height: pt(60), angle: diagonalAngle },
        // the same diagonal mirrored by flipH
        {
          left: pt(600),
          top: pt(460),
          width: pt(80),
          height: pt(60),
          angle: 180 - diagonalAngle,
        },
        // PowerPoint flat-box + rot: the 100pt run at 45deg about the box center
        {
          left: pt(750) - Math.SQRT1_2 * pt(50),
          top: pt(460) - Math.SQRT1_2 * pt(50),
          width: Math.SQRT2 * pt(50),
          height: Math.SQRT2 * pt(50),
          angle: 45,
        },
        // Non-flat straight connector at 90deg with both flips: the box diagonal
        // (42x42pt) rotated about the center -> a 135deg segment spanning the box.
        { left: pt(180), top: pt(174), width: pt(42), height: pt(42), angle: 135 },
        // 102x36pt at 270deg with flipH: (180,216)->(216,318), 70.6deg.
        {
          left: pt(180),
          top: pt(216),
          width: pt(36),
          height: pt(102),
          angle: (Math.atan2(102, 36) * 180) / Math.PI,
        },
      ];
      connectorBoxes.forEach((box, index) => {
        const expected = expectedConnectors[index]!;
        expect(Math.abs(box.left - expected.left)).toBeLessThanOrEqual(3);
        expect(Math.abs(box.top - expected.top)).toBeLessThanOrEqual(3);
        expect(Math.abs(box.width - expected.width)).toBeLessThanOrEqual(3);
        expect(Math.abs(box.height - expected.height)).toBeLessThanOrEqual(3);
        expect(Math.abs(box.angle - expected.angle)).toBeLessThanOrEqual(2);
      });

      // A flipped shape mirrors its geometry/background layer, not its text.
      const flipped = firstSlide.locator(".sidebar-office-pptx__shape", {
        hasText: "Flipped label",
      });
      const flippedStyles = await flipped.evaluate((element) => ({
        fill: getComputedStyle(element.querySelector(".sidebar-office-pptx__shape-fill")!)
          .transform,
        text: getComputedStyle(element.querySelector(".sidebar-office-pptx__text")!).transform,
      }));
      expect(flippedStyles.fill).toContain("-1");
      expect(flippedStyles.text).toBe("none");

      const closing = view.locator(".sidebar-office-pptx__slide").nth(1);
      expect(await closing.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(
        "rgb(31, 56, 100)",
      );
      expect(await closing.textContent()).toContain("Thank you");
      const omitted = await view.locator(".sidebar-office-preview__omitted").textContent();
      expect(omitted).toContain("Charts");
      expect(omitted).toContain("SmartArt diagrams");
      expect(
        await page
          .locator(".sidebar-content")
          .evaluate((element) => element.scrollWidth - element.clientWidth),
      ).toBeLessThanOrEqual(1);
      await page.screenshot({ path: path.join(artifactDir, "after-slides-desktop.png") });
    } finally {
      await context.close();
    }
  });

  it("keeps one fixed slide canvas so shapes never move across panel widths", async () => {
    const context = await browser.newContext({ viewport: { height: 900, width: 2048 } });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(controlUiE2eWaitTimeoutMs);
      await installOfficeGateway(page);
      await page.goto(controlUiSessionUrl(server.baseUrl, sessionKey));
      await openDeck(page);

      const view = page.locator('.sidebar-office-preview[data-office-format="pptx"]');
      await view.waitFor({ state: "visible" });
      await expect.poll(() => view.locator(".sidebar-office-pptx__slide").count()).toBe(2);

      const states: NonNullable<Awaited<ReturnType<typeof sampleSlideCanvas>>>[] = [];
      for (const width of [320, 440, 900]) {
        await resizeSidePanel(page, width);
        await waitForFitScale(page);
        states.push((await page.evaluate(sampleSlideCanvas))!);
        await page.screenshot({ path: path.join(artifactDir, `slide-canvas-${width}.png`) });
      }
      const [narrow, medium, wide] = states as [
        (typeof states)[number],
        (typeof states)[number],
        (typeof states)[number],
      ];
      for (const state of states) {
        // The first declared slide keeps every shape; the second slide follows.
        expect(state.slideCount).toBe(2);
        expect(state.canvasWidth).toBe(1280);
        expect(state.canvasHeight).toBe(720);
        expect(state.shapes).toHaveLength(6);
        expect(state.text).toContain("Merged total");
        expect(state.text).toContain("Thank you");
        // The reader owns horizontal scrolling; the sidebar itself never grows.
        expect(state.sidebarOverflow).toBeLessThanOrEqual(1);
        expect(state.overflowX).toBeGreaterThanOrEqual(0);
        // 16:9 slide: the canvas owns its shape, the reader only scales it.
        expect(state.slideHeight / state.slideWidth).toBeCloseTo(SLIDE_RATIO, 2);
      }
      // Only the scale changes: shape boxes and text layout heights are identical.
      expect(narrow.shapes).toEqual(wide.shapes);
      expect(medium.shapes).toEqual(wide.shapes);
      expect(narrow.paragraphs).toEqual(wide.paragraphs);
      expect(medium.paragraphs).toEqual(wide.paragraphs);
      expect(narrow.slideWidth).toBeLessThan(wide.slideWidth);
      expect(narrow.scale).toBeLessThan(medium.scale);
      expect(medium.scale).toBeLessThan(wide.scale);
      expect(wide.slideWidth).toBeCloseTo(wide.canvasWidth * wide.scale, 0);

      await view.locator('[data-office-zoom="actual"]').click();
      const actual = (await page.evaluate(sampleSlideCanvas))!;
      expect(actual.slideWidth).toBeCloseTo(actual.canvasWidth, 0);
      expect(actual.shapes).toEqual(wide.shapes);
      await view.locator('[data-office-zoom="in"]').click();
      const zoomed = (await page.evaluate(sampleSlideCanvas))!;
      expect(zoomed.slideWidth).toBeGreaterThan(zoomed.canvasWidth);
      expect(zoomed.overflowX).toBeGreaterThan(0);
      expect(zoomed.paragraphs).toEqual(wide.paragraphs);
      await page.screenshot({ path: path.join(artifactDir, "slide-canvas-zoomed.png") });
      await view.locator('[data-office-zoom="fit"]').click();
      await waitForFitScale(page);
      const fitted = (await page.evaluate(sampleSlideCanvas))!;
      expect(fitted.scale).toBeCloseTo(wide.scale, 2);
      expect(fitted.overflowX).toBe(0);
    } finally {
      await context.close();
    }
  });
});
