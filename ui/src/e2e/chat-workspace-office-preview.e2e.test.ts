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

const ONE_PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describeControlUiE2e("Control UI file preview entrypoint regressions", () => {
  it("downloads a managed Files-rail artifact through a fresh, explicit action", async () => {
    const context = await browser.newContext({ acceptDownloads: true });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(controlUiE2eWaitTimeoutMs);
      const managed = managedWorkbookAttachment();
      let served = 0;
      await page.route("**/api/chat/media/outgoing/**", async (route) => {
        served += 1;
        await route.fulfill({
          status: 200,
          headers: {
            "Content-Type": managed.artifact.mimeType,
            "Content-Disposition": `attachment; filename="${managed.artifact.title}"`,
          },
          body: Buffer.from("managed-workbook-bytes"),
        });
      });
      const gateway = await installMockGateway(page, {
        featureMethods: ["chat.metadata", "chat.startup", "sessions.diff"],
        methodResponses: {
          "artifacts.list": { artifacts: [managed.artifact] },
          "artifacts.download": {
            cases: [
              {
                match: { preview: "office" },
                response: { artifact: managed.artifact, preview: managed.readyPreview },
              },
              {
                response: {
                  artifact: managed.artifact,
                  url: `${managed.url}?mediaTicket=ticket-rail-${served}`,
                  expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
                },
              },
            ],
          },
        },
      });
      await page.goto(`${server.baseUrl}chat`);
      await openChatSidePanelType(page, "Files");
      const artifactsChip = page.locator(".chat-workspace-rail__chip").filter({
        hasText: /artifact/iu,
      });
      await artifactsChip.first().click();
      const rail = page
        .locator(".chat-workspace-rail__file-name", { hasText: managed.artifact.title })
        .first();
      await rail.waitFor({ state: "visible" });

      let downloads = 0;
      page.on("download", () => {
        downloads += 1;
      });
      await rail.click();
      const workbook = page.locator('.sidebar-office-preview[data-office-format="xlsx"]');
      await workbook.waitFor({ state: "visible" });
      await expect.poll(() => workbook.textContent()).toContain("Rent");
      // Opening previews; it never downloads.
      expect(downloads).toBe(0);
      await page.screenshot({ path: path.join(artifactDir, "managed-rail-preview.png") });

      const downloadButton = page.locator(".sidebar-office-preview__download");
      await downloadButton.waitFor({ state: "visible" });
      const [download] = await Promise.all([page.waitForEvent("download"), downloadButton.click()]);
      expect(download.suggestedFilename()).toBe(managed.artifact.title);
      // The download re-minted the ticket instead of reusing the preview request.
      const reissues = (await gateway.getRequests("artifacts.download")).filter(
        (request) => (request.params as { preview?: string } | undefined)?.preview !== "office",
      );
      expect(reissues).toHaveLength(1);
      expect(reissues[0]?.params).toMatchObject({
        sessionKey,
        artifactId: managed.artifactId,
      });
      await page.screenshot({ path: path.join(artifactDir, "managed-rail-after-download.png") });
    } finally {
      await context.close();
    }
  });

  it("previews an optimistic outbox workbook before the send is acknowledged", async () => {
    const context = await browser.newContext({
      acceptDownloads: true,
      viewport: { height: 900, width: 1280 },
    });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(controlUiE2eWaitTimeoutMs);
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
              officePreview: managedWorkbookAttachment().readyPreview,
            }),
          });
          return;
        }
        await route.continue();
      });
      await installMockGateway(page, {
        featureMethods: ["chat.metadata", "chat.startup", "sessions.diff"],
      });
      await page.goto(`${server.baseUrl}chat`);
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
      await page.screenshot({ path: path.join(artifactDir, "before-outbox-office-open.png") });
      await expand.click();

      const workbook = page.locator('.sidebar-office-preview[data-office-format="xlsx"]');
      await workbook.waitFor({ state: "visible" });
      await expect.poll(() => workbook.textContent()).toContain("Rent");
      expect(downloads).toBe(0);
      expect(uploadRequests).toEqual(["outbox-budget"]);
      const downloadButton = page.locator(".sidebar-office-preview__download");
      await downloadButton.waitFor({ state: "visible" });
      await page.screenshot({ path: path.join(artifactDir, "after-outbox-office-preview.png") });
      // The retained bytes back an explicit local download under the upload name.
      const [download] = await Promise.all([page.waitForEvent("download"), downloadButton.click()]);
      expect(download.suggestedFilename()).toContain("outbox-budget");
      expect(downloads).toBe(1);
    } finally {
      await context.close();
    }
  });

  it.each([
    {
      id: "artifact_notes_md",
      title: "notes.md",
      mimeType: "text/markdown",
      mode: "bytes" as const,
      body: () => Buffer.from("# Rail notes\n\n- first entry\n- second entry\n").toString("base64"),
      assert: async (page: import("playwright").Page) => {
        const reader = page.locator(".sidebar-markdown-reader");
        await reader.waitFor({ state: "visible" });
        await expect.poll(() => reader.textContent()).toContain("Rail notes");
        await expect.poll(() => reader.locator("li").count()).toBe(2);
        await page.screenshot({ path: path.join(artifactDir, "rail-markdown-preview.png") });
      },
    },
    {
      id: "artifact_log_txt",
      title: "deploy.log",
      mimeType: "text/plain",
      mode: "bytes" as const,
      body: () => Buffer.from("deploy step 1 ok\ndeploy step 2 ok\n").toString("base64"),
      assert: async (page: import("playwright").Page) => {
        const codeView = page.locator(".sidebar-file-view");
        await codeView.waitFor({ state: "visible" });
        await expect.poll(() => codeView.textContent()).toContain("deploy step 1 ok");
        await page.screenshot({ path: path.join(artifactDir, "rail-text-preview.png") });
      },
    },
    {
      id: "artifact_diagram_png",
      title: "diagram.png",
      mimeType: "image/png",
      mode: "bytes" as const,
      body: () => ONE_PIXEL_PNG_BASE64,
      assert: async (page: import("playwright").Page) => {
        const image = page.locator(".chat-tool-card__preview-image");
        await image.waitFor({ state: "visible" });
        await page.screenshot({ path: path.join(artifactDir, "rail-image-preview.png") });
      },
    },
    {
      id: "artifact_sheet_pdf",
      title: "sheet.pdf",
      mimeType: "application/pdf",
      mode: "url" as const,
      body: () => "",
      assert: async (page: import("playwright").Page) => {
        await page.locator("openclaw-chat-pdf-preview").waitFor({ state: "visible" });
        await page.screenshot({ path: path.join(artifactDir, "rail-pdf-preview.png") });
      },
      downloadButtonName: "Download sheet.pdf",
    },
    {
      id: "artifact_voice_mp3",
      title: "voice.mp3",
      mimeType: "audio/mpeg",
      mode: "url" as const,
      body: () => "",
      assert: async (page: import("playwright").Page) => {
        await page.locator("openclaw-chat-audio-player").waitFor({ state: "visible" });
        await page.screenshot({ path: path.join(artifactDir, "rail-audio-preview.png") });
      },
      downloadButtonName: "Download voice.mp3",
    },
  ])("previews the $title Files-rail artifact inline", async (fixture) => {
    const context = await browser.newContext({
      acceptDownloads: true,
      viewport: { height: 900, width: 1280 },
    });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(controlUiE2eWaitTimeoutMs);
      const artifact = {
        id: fixture.id,
        type: fixture.mimeType.startsWith("image/") ? "image" : "file",
        title: fixture.title,
        mimeType: fixture.mimeType,
        sizeBytes: 40,
        download: { mode: fixture.mode },
      };
      await page.route("**/api/artifacts/download/**", async (route) => {
        const filename = new URL(route.request().url()).pathname.split("/").pop();
        await route.fulfill({
          status: 200,
          headers: {
            "Content-Type": fixture.mimeType,
            "Content-Disposition": `attachment; filename="${filename}"`,
          },
          body: Buffer.from("synthetic-preview-bytes"),
        });
      });
      const gateway = await installMockGateway(page, {
        featureMethods: ["chat.metadata", "chat.startup", "sessions.diff"],
        methodResponses: {
          "artifacts.list": { artifacts: [artifact] },
          "artifacts.download": {
            artifact,
            ...(fixture.mode === "bytes"
              ? { encoding: "base64", data: fixture.body() }
              : {
                  url: `/api/artifacts/download/connection/${artifact.id}`,
                  expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
                }),
          },
        },
      });
      await page.goto(`${server.baseUrl}chat`);
      await openChatSidePanelType(page, "Files");
      const artifactsChip = page.locator(".chat-workspace-rail__chip").filter({
        hasText: /artifact/iu,
      });
      await artifactsChip.first().click();
      const row = page
        .locator(".chat-workspace-rail__file-name", { hasText: fixture.title })
        .first();
      await row.waitFor({ state: "visible" });

      let downloads = 0;
      page.on("download", () => {
        downloads += 1;
      });
      await row.click();
      await fixture.assert(page);
      expect(downloads).toBe(0);
      expect((await page.locator("body").textContent()) ?? "").not.toContain("Open artifact");
      // The open never asked for a structured Office preview.
      const opens = await gateway.getRequests("artifacts.download");
      expect(opens.length).toBeGreaterThanOrEqual(1);
      expect(
        opens.filter(
          (request) => (request.params as { preview?: string } | undefined)?.preview === "office",
        ),
      ).toHaveLength(0);
      if ("downloadButtonName" in fixture && fixture.downloadButtonName) {
        // The explicit Download re-runs the fresh RPC and saves the returned URL.
        const [download] = await Promise.all([
          page.waitForEvent("download"),
          page.getByRole("button", { name: fixture.downloadButtonName }).click(),
        ]);
        expect(download.suggestedFilename()).toBe(fixture.title);
        expect(downloads).toBe(1);
        const reissues = (await gateway.getRequests("artifacts.download")).filter(
          (request) => (request.params as { preview?: string } | undefined)?.preview !== "office",
        );
        expect(reissues.length).toBe(opens.length + 1);
      }
    } finally {
      await context.close();
    }
  });

  it("shows a loading state while an outbox workbook parse is in flight", async () => {
    const context = await browser.newContext({ viewport: { height: 900, width: 1280 } });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(controlUiE2eWaitTimeoutMs);
      let releaseUpload: (() => void) | null = null;
      await page.route("**/__openclaw__/assistant-media?**", async (route) => {
        const url = new URL(route.request().url());
        if (route.request().method() === "POST" && url.searchParams.get("upload") === "1") {
          await new Promise<void>((resolve) => {
            releaseUpload = resolve;
          });
          await route.fulfill({
            contentType: "application/json",
            body: JSON.stringify({
              available: true,
              officePreview: managedWorkbookAttachment().readyPreview,
            }),
          });
          return;
        }
        await route.continue();
      });
      await installMockGateway(page, {
        featureMethods: ["chat.metadata", "chat.startup", "sessions.diff"],
      });
      await page.goto(`${server.baseUrl}chat`);
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.fill("Upload while the parse is held");
      await page.locator(".agent-chat__file-input").setInputFiles({
        name: "loading-budget.xlsx",
        mimeType: officeMime,
        buffer: Buffer.from("PK-held-upload"),
      });
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      const card = page
        .locator(".chat-assistant-attachment-card--compact")
        .filter({ hasText: "loading-budget.xlsx" });
      await card.locator(".chat-assistant-attachment-card__expand").click();
      const loadingState = page.locator(".sidebar-office-preview__state[role='status']");
      await loadingState.waitFor({ state: "visible" });
      await expect.poll(() => loadingState.textContent()).toBeTruthy();
      expect(await page.locator(".sidebar-office-preview[data-office-format]").count()).toBe(0);
      await page.screenshot({ path: path.join(artifactDir, "office-loading-state.png") });
      releaseUpload?.();
      await page
        .locator('.sidebar-office-preview[data-office-format="xlsx"]')
        .waitFor({ state: "visible" });
    } finally {
      await context.close();
    }
  });

  it.each([
    {
      id: "artifact_corrupt_xlsx",
      title: "corrupt.xlsx",
      preview: { kind: "office", format: "xlsx", state: "invalid" },
      screenshot: "office-invalid-state.png",
    },
    {
      id: "artifact_huge_xlsx",
      title: "huge.xlsx",
      preview: { kind: "office", format: "xlsx", state: "too-large" },
      screenshot: "office-too-large-state.png",
    },
  ])("keeps a $title rail artifact explicit about its preview state", async (state) => {
    const context = await browser.newContext({ viewport: { height: 900, width: 1280 } });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(controlUiE2eWaitTimeoutMs);
      const artifact = {
        id: state.id,
        type: "file",
        title: state.title,
        mimeType: officeMime,
        sizeBytes: 2048,
        download: { mode: "bytes" },
      };
      await installMockGateway(page, {
        featureMethods: ["chat.metadata", "chat.startup", "sessions.diff"],
        methodResponses: {
          "artifacts.list": { artifacts: [artifact] },
          "artifacts.download": {
            cases: [
              {
                match: { preview: "office" },
                response: { artifact, preview: state.preview },
              },
              { response: { artifact, encoding: "base64", data: "UEsAAQ==" } },
            ],
          },
        },
      });
      await page.goto(`${server.baseUrl}chat`);
      await openChatSidePanelType(page, "Files");
      const artifactsChip = page.locator(".chat-workspace-rail__chip").filter({
        hasText: /artifact/iu,
      });
      await artifactsChip.first().click();
      const row = page.locator(".chat-workspace-rail__file-name", { hasText: state.title }).first();
      await row.waitFor({ state: "visible" });
      await row.click();
      await expect
        .poll(() => page.locator(".sidebar-attachment-preview__notice").first().textContent())
        .toBeTruthy();
      expect(await page.locator(".sidebar-office-preview[data-office-format]").count()).toBe(0);
      expect(
        await page
          .locator(".sidebar-attachment-preview .chat-assistant-attachment-card__download")
          .count(),
      ).toBe(1);
      await page.screenshot({ path: path.join(artifactDir, state.screenshot) });
    } finally {
      await context.close();
    }
  });
});
