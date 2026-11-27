// Real-browser proof that Word pages keep their authored non-A4 page box.
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

let artifactDir: string;
let browser: Browser;
let server: ControlUiE2eServer;

beforeEach(() => {
  artifactDir = createControlUiE2eArtifactDir("chat-office-docx-non-a4");
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

const letterMargins = {
  marginTopPt: 72,
  marginRightPt: 72,
  marginBottomPt: 72,
  marginLeftPt: 72,
};

function singleLine(text: string) {
  return {
    blocks: [
      { kind: "paragraph" as const, role: "body" as const, text, runs: [{ text, fontSizePt: 11 }] },
    ],
  };
}

/** Letter portrait and Letter landscape: neither matches the A4 fallback box. */
const letterPayload = {
  format: "docx",
  pages: [
    { widthPt: 612, heightPt: 792, ...letterMargins, ...singleLine("Single line letter body") },
    { widthPt: 792, heightPt: 612, ...letterMargins, ...singleLine("Landscape page") },
  ],
};

/** Authored canvas sizes in CSS pixels, and one 11pt line at 1.35 line height. */
const LETTER_CANVAS = { height: Math.round((792 * 4) / 3), width: Math.round((612 * 4) / 3) };
const LETTER_LANDSCAPE_CANVAS = {
  height: Math.round((612 * 4) / 3),
  width: Math.round((792 * 4) / 3),
};
const WORD_LINE_BOX_PX = 11 * (4 / 3) * 1.35;

const letterFixtureName = "letter-report.docx";

function officeResponses() {
  return {
    "sessions.files.list": {
      browser: {
        entries: [{ kind: "file", name: letterFixtureName, path: letterFixtureName, size: 4096 }],
        path: "",
      },
      files: [
        {
          kind: "read",
          missing: false,
          name: letterFixtureName,
          path: letterFixtureName,
          size: 4096,
        },
      ],
      root: fileRoot,
      sessionKey,
    },
    "sessions.files.get": {
      cases: [letterFixtureName, `${fileRoot}/${letterFixtureName}`].map((requestPath) => ({
        match: { path: requestPath },
        response: {
          root: fileRoot,
          sessionKey,
          file: {
            kind: "read",
            missing: false,
            name: letterFixtureName,
            path: letterFixtureName,
            workspacePath: letterFixtureName,
            size: 4096,
            mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            officePreview: letterPayload,
            previewKind: "office",
          },
        },
      })),
    },
  };
}

async function openRailFile(page: import("playwright").Page, name: string) {
  await openChatSidePanelType(page, "Files");
  const row = page.locator(".chat-workspace-rail__file-name:visible", { hasText: name }).first();
  await row.waitFor({ state: "visible" });
  await row.click();
}

/**
 * Rendered box of every fixed card against the scaler that reserves it, plus
 * the one-line paragraph's authored line box. Runs inside the page: keep it
 * self-contained.
 */
function samplePageBoxes() {
  const reader = [...document.querySelectorAll<HTMLElement>(".sidebar-office-docx__scroll")].find(
    (element) => element.clientWidth > 0,
  );
  const cards = [...(reader?.querySelectorAll<HTMLElement>(".sidebar-office-docx__page") ?? [])];
  if (!reader || cards.length === 0) {
    return null;
  }
  const paragraph = [
    ...reader.querySelectorAll<HTMLElement>(".sidebar-office-docx__paragraph"),
  ].find((element) => element.textContent?.includes("Single line letter body"));
  const text = paragraph?.querySelector<HTMLElement>(".sidebar-office-docx__text");
  return {
    boxes: cards.map((card) => {
      const rect = card.getBoundingClientRect();
      const scaler = card.parentElement!.getBoundingClientRect();
      return {
        height: rect.height,
        scalerHeight: scaler.height,
        scalerWidth: scaler.width,
        width: rect.width,
      };
    }),
    overflowX: reader.scrollWidth - reader.clientWidth,
    paragraphHeight: paragraph?.offsetHeight ?? 0,
    scale: Number.parseFloat(
      getComputedStyle(reader).getPropertyValue("--office-canvas-scale").trim() || "NaN",
    ),
    textOffsetTop:
      paragraph && text
        ? text.getBoundingClientRect().top - paragraph.getBoundingClientRect().top
        : -1,
  };
}

describeControlUiE2e("Control UI layout Word non-A4 side-panel preview", () => {
  it("fits Letter and landscape pages to their own boxes and one authored line", async () => {
    const context = await browser.newContext({ viewport: { height: 900, width: 1280 } });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(controlUiE2eWaitTimeoutMs);
      await installMockGateway(page, {
        featureMethods: ["chat.metadata", "chat.startup", "sessions.diff"],
        methodResponses: officeResponses(),
      });
      await page.goto(controlUiSessionUrl(server.baseUrl, sessionKey));
      await openRailFile(page, letterFixtureName);

      const view = page.locator('.sidebar-office-preview[data-office-format="docx"]');
      await view.waitFor({ state: "visible" });
      await expect.poll(() => view.locator(".sidebar-office-docx__page").count()).toBe(2);
      await expect.poll(() => view.locator(".sidebar-office-docx__measure").count()).toBe(0);

      const state = (await page.evaluate(samplePageBoxes))!;
      // Neither page matches the A4 fallback box; both still fit the reader.
      expect(state.overflowX).toBeLessThanOrEqual(1);
      expect(state.boxes).toHaveLength(2);
      for (const [index, box] of state.boxes.entries()) {
        const canvas = index === 0 ? LETTER_CANVAS : LETTER_LANDSCAPE_CANVAS;
        expect(box.width).toBeCloseTo(canvas.width * state.scale, 0);
        expect(box.height).toBeCloseTo(canvas.height * state.scale, 0);
        // The scaler reserves exactly the transformed page box.
        expect(box.scalerWidth).toBeCloseTo(box.width, 0);
        expect(box.scalerHeight).toBeCloseTo(box.height, 0);
      }
      // A one-line paragraph keeps one line box: template indentation never
      // becomes leading blank lines, so measured pagination stays honest.
      expect(state.paragraphHeight).toBeLessThanOrEqual(Math.round(WORD_LINE_BOX_PX * 1.5));
      expect(state.textOffsetTop).toBeLessThanOrEqual(2);
      await page.screenshot({ path: path.join(artifactDir, "after-docx-letter-fit.png") });
    } finally {
      await context.close();
    }
  });
});
