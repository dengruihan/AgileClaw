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
      // Sparse sheet: rows 1 and 3 exist, row 2 is empty.
      rowNumbers: [1, 3],
      rows: [
        ["Item", "Cost"],
        ["Rent", "1200"],
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

const officeMime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function managedWorkbookAttachment() {
  const attachmentId = "11111111-1111-4111-8111-111111111111";
  const artifactId = `artifact_managed_media_${attachmentId}`;
  return {
    artifactId,
    url: `/api/chat/media/outgoing/agent%3Amain%3Amain/${attachmentId}/full`,
    artifact: {
      id: artifactId,
      type: "file",
      title: "applications.xlsx",
      mimeType: officeMime,
      sizeBytes: 2048,
      sessionKey,
      source: "session-transcript",
      download: { mode: "url" },
    },
    readyPreview: {
      kind: "office",
      format: "xlsx",
      state: "ready",
      preview: workbookPayload,
    },
  };
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
      expect(
        await workbook
          .locator(".sidebar-office-preview__row-number")
          .allTextContents()
          .then((labels) => labels.map((label) => label.trim())),
      ).toEqual(["1", "3"]);
      const requestCount = (await gateway.getRequests("sessions.files.get")).length;
      expect(requestCount).toBe(1);
      await page.screenshot({ path: path.join(artifactDir, "after-xlsx-preview.png") });

      await page.locator('[role="tab"]', { hasText: "Notes" }).click();
      await expect.poll(() => workbook.locator("table").textContent()).toContain("Renew in March");
      // Worksheet switching stays client-side.
      expect((await gateway.getRequests("sessions.files.get")).length).toBe(requestCount);
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
      await page.screenshot({ path: path.join(artifactDir, "legacy-xls-metadata-only.png") });
      fs.writeFileSync(
        path.join(artifactDir, "office-preview-requests.json"),
        JSON.stringify(await gateway.getRequests("sessions.files.get"), null, 2),
      );
    } finally {
      await context.close();
    }
  });

  it("captures the pre-change metadata state for the same workbook", async () => {
    // The branch before this change returned `previewKind: "unsupported"` for
    // every Office file; replay that gateway response for the same file the
    // "after" screenshot opens.
    const context = await browser.newContext({ viewport: { height: 900, width: 1280 } });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(controlUiE2eWaitTimeoutMs);
      await installMockGateway(page, {
        featureMethods: ["chat.metadata", "chat.startup", "sessions.diff"],
        methodResponses: {
          ...officeResponses(),
          "sessions.files.get": {
            cases: ["budget.xlsx", `${fileRoot}/budget.xlsx`].map((requestPath) => ({
              match: { path: requestPath },
              response: officeResponse("budget.xlsx", {
                mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                previewKind: "unsupported",
              }),
            })),
          },
        },
      });
      await page.goto(`${server.baseUrl}chat`);
      await openRailFile(page, "budget.xlsx");
      await expect
        .poll(() => page.locator(".sidebar-markdown-reader").textContent())
        .toContain("This file is not previewable inline.");
      await page.screenshot({
        path: path.join(artifactDir, "before-budget-xlsx-metadata-only.png"),
      });
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

  it("opens an AI-sent workbook attachment as a preview before any download", async () => {
    const context = await browser.newContext({ viewport: { height: 900, width: 1280 } });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(controlUiE2eWaitTimeoutMs);
      const managed = managedWorkbookAttachment();
      const gateway = await installMockGateway(page, {
        featureMethods: ["chat.metadata", "chat.startup", "sessions.diff"],
        historyMessages: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "Here is the workbook." },
              {
                type: "attachment",
                attachment: {
                  artifactId: managed.artifactId,
                  kind: "document",
                  label: "applications.xlsx",
                  mimeType: officeMime,
                  sizeBytes: 2048,
                  url: managed.url,
                },
              },
            ],
            timestamp: Date.now(),
          },
        ],
        methodResponses: {
          "artifacts.download": {
            cases: [
              {
                match: { preview: "office" },
                response: { artifact: managed.artifact, preview: managed.readyPreview },
              },
              {
                response: {
                  artifact: managed.artifact,
                  url: `${managed.url}?mediaTicket=ticket-attachment`,
                  expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
                },
              },
            ],
          },
        },
      });
      await page.goto(`${server.baseUrl}chat`);
      const card = page
        .locator(".chat-assistant-attachment-card--compact")
        .filter({ hasText: "applications.xlsx" });
      const expand = card.locator(".chat-assistant-attachment-card__expand");
      await expand.waitFor({ state: "visible" });
      await page.screenshot({ path: path.join(artifactDir, "before-attachment-card.png") });

      let downloads = 0;
      page.on("download", () => {
        downloads += 1;
      });
      await expand.click();

      const workbook = page.locator('.sidebar-office-preview[data-office-format="xlsx"]');
      await workbook.waitFor({ state: "visible" });
      await expect.poll(() => workbook.locator("table").textContent()).toContain("Rent");
      expect(downloads).toBe(0);
      expect(await gateway.getRequests("sessions.files.get")).toHaveLength(0);
      const previewRequests = (await gateway.getRequests("artifacts.download")).filter(
        (request) => (request.params as { preview?: string } | undefined)?.preview === "office",
      );
      expect(previewRequests).toHaveLength(1);
      expect(previewRequests[0]?.params).toMatchObject({
        sessionKey,
        artifactId: managed.artifactId,
      });
      // Download is a separate, explicitly labeled action.
      const downloadButton = page.locator(".sidebar-office-preview__download");
      await downloadButton.waitFor({ state: "visible" });
      expect((await downloadButton.textContent())?.trim()).toContain("Download");
      await page.screenshot({ path: path.join(artifactDir, "after-attachment-preview.png") });
    } finally {
      await context.close();
    }
  });

  it("opens a Files-rail artifact as a preview instead of an Open artifact download link", async () => {
    const context = await browser.newContext({ viewport: { height: 900, width: 1280 } });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(controlUiE2eWaitTimeoutMs);
      const artifactId = "artifact_office_rail";
      const artifact = {
        id: artifactId,
        type: "file",
        title: "budget.xlsx",
        mimeType: officeMime,
        sizeBytes: 2048,
        download: { mode: "bytes" },
      };
      const gateway = await installMockGateway(page, {
        featureMethods: ["chat.metadata", "chat.startup", "sessions.diff"],
        methodResponses: {
          ...officeResponses(),
          "artifacts.list": { artifacts: [artifact] },
          "artifacts.download": {
            artifact,
            preview: {
              kind: "office",
              format: "xlsx",
              state: "ready",
              preview: workbookPayload,
            },
          },
        },
      });
      await page.goto(`${server.baseUrl}chat`);
      await openChatSidePanelType(page, "Files");
      const artifactsChip = page
        .locator(".chat-workspace-rail__chip")
        .filter({ hasText: /artifact/iu });
      await artifactsChip.first().click();
      const rail = page.locator(".chat-workspace-rail__file-name", { hasText: "budget.xlsx" });
      await rail.first().waitFor({ state: "visible" });
      await page.screenshot({ path: path.join(artifactDir, "before-artifact-rail.png") });

      let downloads = 0;
      page.on("download", () => {
        downloads += 1;
      });
      await rail.first().click();

      const workbook = page.locator('.sidebar-office-preview[data-office-format="xlsx"]');
      await workbook.waitFor({ state: "visible" });
      await expect.poll(() => workbook.textContent()).toContain("Rent");
      expect(downloads).toBe(0);
      // The old fallback rendered a raw "Open artifact" Markdown link.
      expect((await page.locator("body").textContent()) ?? "").not.toContain("Open artifact");
      const request = await gateway.waitForRequest("artifacts.download");
      expect(request.params).toMatchObject({ artifactId, preview: "office" });
      await page.screenshot({ path: path.join(artifactDir, "after-artifact-preview.png") });
    } finally {
      await context.close();
    }
  });

  it("keeps a legacy Office attachment metadata-only with an explicit download", async () => {
    const context = await browser.newContext({ viewport: { height: 900, width: 1280 } });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(controlUiE2eWaitTimeoutMs);
      const source = "/tmp/openclaw/old-ledger.xls";
      await page.route("**/__openclaw__/assistant-media?**", async (route) => {
        const url = new URL(route.request().url());
        if (url.searchParams.get("meta") === "1") {
          await route.fulfill({
            contentType: "application/json",
            body: JSON.stringify({
              available: true,
              mediaTicket: "ticket-legacy",
              mediaTicketExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
            }),
          });
          return;
        }
        await route.fulfill({
          contentType: "application/vnd.ms-excel",
          body: Buffer.from("legacy-office-bytes"),
        });
      });
      await installMockGateway(page, {
        featureMethods: ["chat.metadata", "chat.startup", "sessions.diff"],
        historyMessages: [
          {
            role: "assistant",
            content: [
              {
                type: "attachment",
                attachment: {
                  kind: "document",
                  label: "old-ledger.xls",
                  mimeType: "application/vnd.ms-excel",
                  sizeBytes: 1024,
                  url: source,
                },
              },
            ],
            timestamp: Date.now(),
          },
        ],
      });
      await page.goto(`${server.baseUrl}chat`);
      const card = page
        .locator(".chat-assistant-attachment-card--compact")
        .filter({ hasText: "old-ledger.xls" });
      await card.locator(".chat-assistant-attachment-card__expand").click();
      await expect
        .poll(() => page.locator(".sidebar-attachment-preview__notice").textContent())
        .toContain("Legacy Office");
      expect(await page.locator('.sidebar-office-preview[data-office-format="xlsx"]').count()).toBe(
        0,
      );
      expect(
        await page
          .locator(".sidebar-attachment-preview .chat-assistant-attachment-card__download")
          .count(),
      ).toBe(1);
      await page.screenshot({ path: path.join(artifactDir, "legacy-xls-attachment-card.png") });
    } finally {
      await context.close();
    }
  });
});
