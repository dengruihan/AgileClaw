// Real-browser proof for the Control UI Office preview in the chat side panel.
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  canRunPlaywrightChromium,
  controlUiE2eWaitTimeoutMs,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
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

const fileRoot = "/workspace";
const sessionKey = "agent:main:main";

const workbookPayload = {
  format: "xlsx",
  sheets: [
    {
      name: "Budget",
      rowCount: 3,
      columnCount: 2,
      rows: [
        ["Item", "Cost"],
        ["Rent", "1200"],
        ["Coffee", "48"],
      ],
    },
    {
      name: "Notes",
      rowCount: 2,
      columnCount: 1,
      rows: [["Renew in March"], ["Ask finance"]],
    },
  ],
};

const documentPayload = {
  format: "docx",
  blocks: [
    { kind: "heading", level: 1, text: "Quarterly report" },
    { kind: "paragraph", text: "Revenue grew across every region." },
    { kind: "listItem", text: "Ship the preview" },
    { kind: "listItem", text: "Measure adoption" },
  ],
  truncated: true,
};

const presentationPayload = {
  format: "pptx",
  slides: [
    { index: 1, title: "Roadmap", lines: ["Ship previews", "Measure adoption"] },
    { index: 2, title: "Risks", lines: ["Large workbooks"] },
  ],
};

type OfficeFixture = {
  name: string;
  mimeType: string;
  file: Record<string, unknown>;
};

const officeFixtures: OfficeFixture[] = [
  {
    name: "budget.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    file: { officePreview: workbookPayload, previewKind: "office" },
  },
  {
    name: "report.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    file: { officePreview: documentPayload, previewKind: "office" },
  },
  {
    name: "deck.pptx",
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    file: { officePreview: presentationPayload, previewKind: "office" },
  },
  {
    name: "legacy.xls",
    mimeType: "application/vnd.ms-excel",
    file: { previewKind: "unsupported" },
  },
];

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
      size: 2048,
      ...file,
    },
  };
}

function officeResponses() {
  return {
    "sessions.files.list": {
      browser: {
        entries: officeFixtures.map(({ name }) => ({ kind: "file", name, path: name, size: 2048 })),
        path: "",
      },
      files: officeFixtures.map(({ name }) => ({
        kind: "read",
        missing: false,
        name,
        path: name,
        size: 2048,
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

describeControlUiE2e("Control UI Office side-panel preview", () => {
  it("renders a spreadsheet with worksheet switching", async () => {
    const context = await browser.newContext({ viewport: { height: 900, width: 1280 } });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(controlUiE2eWaitTimeoutMs);
      const gateway = await installMockGateway(page, {
        featureMethods: ["chat.metadata", "chat.startup", "sessions.diff"],
        methodResponses: officeResponses(),
      });
      await page.goto(`${server.baseUrl}chat`);
      await openRailFile(page, "budget.xlsx");

      const workbook = page.locator('.sidebar-office-preview[data-office-format="xlsx"]');
      await workbook.waitFor({ state: "visible" });
      await expect.poll(() => workbook.locator("table").textContent()).toContain("Rent");
      const requestCount = (await gateway.getRequests("sessions.files.get")).length;
      expect(requestCount).toBe(1);

      await page.locator('[role="tab"]', { hasText: "Notes" }).click();
      await expect.poll(() => workbook.locator("table").textContent()).toContain("Renew in March");
      // Worksheet switching stays client-side.
      expect((await gateway.getRequests("sessions.files.get")).length).toBe(requestCount);
      await page.screenshot({ path: path.join(artifactDir, "after-xlsx-preview.png") });
    } finally {
      await context.close();
    }
  });

  it("renders a document body", async () => {
    const context = await browser.newContext({ viewport: { height: 900, width: 1280 } });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(controlUiE2eWaitTimeoutMs);
      await installMockGateway(page, {
        featureMethods: ["chat.metadata", "chat.startup", "sessions.diff"],
        methodResponses: officeResponses(),
      });
      await page.goto(`${server.baseUrl}chat`);
      await openRailFile(page, "report.docx");

      const documentPreview = page.locator('.sidebar-office-preview[data-office-format="docx"]');
      await documentPreview.waitFor({ state: "visible" });
      await expect
        .poll(() => documentPreview.locator('[role="heading"]').textContent())
        .toContain("Quarterly report");
      await expect.poll(() => documentPreview.locator("ul li").count()).toBe(2);
      await expect.poll(() => documentPreview.textContent()).toContain("truncated");
      await page.screenshot({ path: path.join(artifactDir, "after-docx-preview.png") });
    } finally {
      await context.close();
    }
  });

  it("renders a slide outline", async () => {
    const context = await browser.newContext({ viewport: { height: 900, width: 1280 } });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(controlUiE2eWaitTimeoutMs);
      await installMockGateway(page, {
        featureMethods: ["chat.metadata", "chat.startup", "sessions.diff"],
        methodResponses: officeResponses(),
      });
      await page.goto(`${server.baseUrl}chat`);
      await openRailFile(page, "deck.pptx");

      const presentationPreview = page.locator(
        '.sidebar-office-preview[data-office-format="pptx"]',
      );
      await presentationPreview.waitFor({ state: "visible" });
      await expect.poll(() => presentationPreview.locator("[data-slide-index]").count()).toBe(2);
      await expect.poll(() => presentationPreview.textContent()).toContain("Roadmap");
      await page.screenshot({ path: path.join(artifactDir, "after-pptx-preview.png") });
    } finally {
      await context.close();
    }
  });

  it("keeps legacy Office containers and the previous state metadata-only", async () => {
    const context = await browser.newContext({ viewport: { height: 900, width: 1280 } });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(controlUiE2eWaitTimeoutMs);
      const gateway = await installMockGateway(page, {
        featureMethods: ["chat.metadata", "chat.startup", "sessions.diff"],
        methodResponses: officeResponses(),
      });
      await page.goto(`${server.baseUrl}chat`);
      await openRailFile(page, "legacy.xls");
      await expect
        .poll(() => page.locator(".sidebar-markdown-reader").textContent())
        .toContain("application/vnd.ms-excel");
      await page.screenshot({ path: path.join(artifactDir, "before-metadata-only-xls.png") });
      fs.writeFileSync(
        path.join(artifactDir, "office-preview-requests.json"),
        JSON.stringify(await gateway.getRequests("sessions.files.get"), null, 2),
      );
    } finally {
      await context.close();
    }
  });

  it("keeps the workbook legible in a narrow dark side panel", async () => {
    const context = await browser.newContext({
      colorScheme: "dark",
      viewport: { height: 820, width: 900 },
    });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(controlUiE2eWaitTimeoutMs);
      await installMockGateway(page, {
        featureMethods: ["chat.metadata", "chat.startup", "sessions.diff"],
        methodResponses: officeResponses(),
      });
      await page.goto(`${server.baseUrl}chat`);
      await openRailFile(page, "budget.xlsx");
      const workbook = page.locator('.sidebar-office-preview[data-office-format="xlsx"]');
      await workbook.waitFor({ state: "visible" });
      const overflow = await page.locator(".sidebar-content").evaluate((element) => {
        return element.scrollWidth - element.clientWidth;
      });
      expect(overflow).toBeLessThanOrEqual(1);
      expect(await workbook.locator(".sidebar-office-preview__grid-scroll").count()).toBe(1);
      await page.screenshot({ path: path.join(artifactDir, "after-xlsx-preview-narrow-dark.png") });
    } finally {
      await context.close();
    }
  });
});
