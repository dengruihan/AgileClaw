// Real-browser proof for the Control UI Office PDF preview in the chat side panel.
import path from "node:path";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  type ControlUiE2eServer,
  canRunPlaywrightChromium,
  controlUiSessionUrl,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;

let artifactDir: string;
let browser: Browser;
let server: ControlUiE2eServer;

beforeEach(() => {
  artifactDir = createControlUiE2eArtifactDir("chat-workspace-office-preview");
});

beforeAll(async () => {
  server = await startControlUiE2eServer();
  browser = await chromium.launch({ executablePath: chromiumExecutablePath });
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const sessionKey = "agent:main:main";
const officeMime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// One-page Letter PDF, so the browser's own reader renders the preview.
const WORKBOOK_PDF_BASE64 =
  "JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA0IDAgUiA+PiA+PiAvQ29udGVudHMgNSAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iago1IDAgb2JqCjw8IC9MZW5ndGggNjAgPj4Kc3RyZWFtCkJUIC9GMSAxOCBUZiA3MiA3MjAgVGQgKENvbnZlcnRlZCBzcHJlYWRzaGVldCBwcmV2aWV3KSBUaiBFVAplbmRzdHJlYW0KZW5kb2JqCnhyZWYKMCA2CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAwOSAwMDAwMCBuIAowMDAwMDAwMDU4IDAwMDAwIG4gCjAwMDAwMDAxMTUgMDAwMDAgbiAKMDAwMDAwMDI0MSAwMDAwMCBuIAowMDAwMDAwMzExIDAwMDAwIG4gCnRyYWlsZXIKPDwgL1NpemUgNiAvUm9vdCAxIDAgUiA+PgpzdGFydHhyZWYKNDIxCiUlRU9GCg==";

const workbookPdf = {
  mimeType: "application/pdf" as const,
  data: WORKBOOK_PDF_BASE64,
  sizeBytes: 604,
};

function reader(page: import("playwright").Page) {
  return page.locator("openclaw-chat-pdf-preview:visible");
}

async function expectPdfData(frame: import("playwright").Locator, data: string) {
  await expect
    .poll(() =>
      frame.evaluate((element) => (element as HTMLElement & { pdfData?: string }).pdfData),
    )
    .toBe(data);
  await expect.poll(() => frame.locator("iframe").getAttribute("src")).toMatch(/^blob:/u);
}

describeControlUiE2e("Control UI Office PDF side-panel preview", () => {
  it("previews an optimistic outbox workbook through the upload conversion", async () => {
    const context = await browser.newContext({
      acceptDownloads: true,
      viewport: { height: 900, width: 1280 },
    });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(30_000);
      const uploadRequests: string[] = [];
      await page.route("**/__openclaw__/assistant-media?**", async (route) => {
        const url = new URL(route.request().url());
        if (
          route.request().method() === "POST" &&
          url.searchParams.get("upload") === "1" &&
          url.searchParams.get("preview") === "office"
        ) {
          uploadRequests.push(url.searchParams.get("filename") ?? "");
          expect(url.searchParams.get("type")).toBe(officeMime);
          await route.fulfill({
            contentType: "application/json",
            body: JSON.stringify({
              available: true,
              officePreview: {
                kind: "office",
                format: "xlsx",
                state: "ready",
                pdf: workbookPdf,
              },
            }),
          });
          return;
        }
        await route.continue();
      });
      await installMockGateway(page, {
        featureMethods: ["chat.metadata", "chat.startup", "sessions.diff"],
      });
      await page.goto(controlUiSessionUrl(server.baseUrl, sessionKey));
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.fill("Outbox workbook for preview");
      await page.locator(".agent-chat__file-input").setInputFiles({
        // Extensionless on purpose: format detection must come from the MIME.
        name: "outbox-budget",
        mimeType: officeMime,
        buffer: Buffer.from("PK-synthetic-outbox-workbook"),
      });
      const send = page.getByRole("button", { name: "Send message", exact: true });
      await send.waitFor({ state: "visible" });
      await expect.poll(() => send.isEnabled()).toBe(true);
      await send.click();

      let downloads = 0;
      page.on("download", () => {
        downloads += 1;
      });
      const card = page
        .locator(".chat-assistant-attachment-card--compact")
        .filter({ hasText: "outbox-budget" });
      const expand = card.locator(".chat-assistant-attachment-card__expand");
      await expand.waitFor({ state: "visible" });
      await expand.click();

      await expectPdfData(reader(page), workbookPdf.data);
      expect(uploadRequests).toEqual(["outbox-budget"]);
      expect(downloads).toBe(0);

      // The converted PDF keeps its fixed layout while the panel narrows.
      for (const width of [320, 440, 900]) {
        await page.setViewportSize({ width, height: 900 });
        await page.waitForTimeout(400);
        await page.screenshot({ path: path.join(artifactDir, `outbox-pdf-${width}.png`) });
      }
      await page.setViewportSize({ width: 1280, height: 900 });

      const downloadButton = page.locator(".sidebar-office-preview__download:visible");
      await downloadButton.waitFor({ state: "visible" });
      const [download] = await Promise.all([page.waitForEvent("download"), downloadButton.click()]);
      expect(download.suggestedFilename()).toContain("outbox-budget");
      expect(downloads).toBe(1);
      await page.screenshot({ path: path.join(artifactDir, "outbox-attachment-pdf.png") });
    } finally {
      await context.close();
    }
  });
});
