import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright-core";
import { expect, it } from "vitest";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  captureUiProof,
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

const sessionKey = "agent:main:pdf-export";
const otherSessionKey = "agent:main:pdf-export-other";
const thinkingText = "Synthetic reasoning the user asked us to keep out.";
const toolOutput = "synthetic-tool-output-must-not-be-exported";
const history = [
  { role: "user", content: "Which checks gate the release?", timestamp: 1_000 },
  {
    role: "assistant",
    content: [
      { type: "thinking", thinking: thinkingText },
      { type: "text", text: "Tests and the UI lane gate the release." },
      { type: "toolCall", id: "gate-check", name: "exec", arguments: { command: "synthetic" } },
    ],
    timestamp: 2_000,
  },
  { role: "toolResult", toolCallId: "gate-check", content: toolOutput },
  {
    role: "assistant",
    content: "## Gate summary\n\n- `pnpm test`\n- **UI lane**",
    timestamp: 3_000,
  },
  { role: "user", content: "请把发布清单整理成 PDF。", timestamp: 4_000 },
  {
    role: "assistant",
    content: "导出只包含用户与 AI 的正文。\n\n```ts\nconst page = exportPdf();\n```",
    timestamp: 5_000,
  },
];

/** Serves the transcript in small pages so the export must walk every offset. */
async function installPaginatedHistory(page: Page, messages: unknown[]) {
  await page.evaluate(
    ({ messages: source }) => {
      const mockGateway = (
        window as unknown as {
          openclawControlUiE2eGateway?: {
            setRequestHandler: (
              method: string,
              handler: (context: { params: unknown; respond: (payload: unknown) => void }) => void,
            ) => void;
          };
        }
      ).openclawControlUiE2eGateway;
      if (!mockGateway) {
        throw new Error("Mock Gateway is unavailable");
      }
      const pageSize = 2;
      mockGateway.setRequestHandler("chat.history", ({ params, respond }) => {
        const query = (params ?? {}) as { offset?: number; agentId?: string; sessionKey?: string };
        const offset = typeof query.offset === "number" ? query.offset : 0;
        const total = source.length;
        const end = Math.max(0, total - offset);
        const start = Math.max(0, end - pageSize);
        respond({
          sessionId:
            query.sessionKey?.endsWith("pdf-export-other") === true
              ? "session:agent:main:pdf-export-other"
              : "session:agent:main:pdf-export",
          messages: source.slice(start, end),
          totalMessages: total,
          hasMore: start > 0,
          ...(start > 0 ? { nextOffset: offset + (end - start) } : {}),
          deltaCursor: "pdf-export-cursor",
          sessionInfo: { activeLeafEntryId: "pdf-export-leaf" },
        });
      });
    },
    { messages },
  );
}

async function openPdfExportAction(page: Page) {
  // Cached panes keep their headers mounted; act on the pane the operator sees.
  const pane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
  await pane.locator(".chat-header-session-menu__trigger").first().click();
  const menu = pane.locator("openclaw-chat-header-session-menu").first();
  const action = menu.locator('wa-dropdown-item[value="export-pdf"]');
  await action.waitFor({ state: "visible" });
  return action;
}

function pdfText(bytes: Uint8Array): string {
  return new TextDecoder("latin1").decode(bytes);
}

function pageCount(document: string): number {
  const match = /\/Type \/Pages \/Kids \[[^\]]*\] \/Count (\d+)/u.exec(document);
  return Number(match?.[1] ?? 0);
}

suite.define(() => {
  it("exports the complete paginated history as a light PDF without thinking or tool output", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        sessionKey,
        featureMethods: ["chat.metadata", "chat.startup", "chat.history"],
        historyMessages: history,
        methodResponses: {
          "sessions.list": sessionsListResponse([
            sessionRow(sessionKey, "Release planning", Date.parse("2026-11-17T06:00:00Z")),
            sessionRow(otherSessionKey, "Other session", Date.parse("2026-11-17T05:00:00Z")),
          ]),
        },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      await gateway.waitForRequest("chat.startup");
      await installPaginatedHistory(page, history);
      const pane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
      await pane.getByText("Which checks gate the release?", { exact: true }).waitFor();

      const exportAction = await openPdfExportAction(page);
      await captureUiProof(suite, page, "pdf-export-menu.png");

      const downloadPromise = page.waitForEvent("download");
      await exportAction.click();
      const download = await downloadPromise;
      expect(download.suggestedFilename()).toMatch(/^openclaw-chat-.+\.pdf$/);
      const stream = await download.createReadStream();
      if (!stream) {
        throw new Error("PDF export did not provide a readable download");
      }
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk as Uint8Array));
      }
      const bytes = new Uint8Array(Buffer.concat(chunks));
      const document = pdfText(bytes);

      // A real PDF document, not a print dialog or a renamed text file.
      expect(document.startsWith("%PDF-1.4")).toBe(true);
      expect(pageCount(document)).toBeGreaterThan(0);
      expect(document).toContain("/MediaBox [0 0 595.28 841.89]");
      // Light theme panel fill plus dark ink.
      expect(document).toContain("0.965 0.972 0.98 rg");
      expect(document).toContain("0.11 0.13 0.17 rg");
      // User bodies and assistant bodies from every history page survive.
      expect(document).toContain("(Which checks gate the release?) Tj");
      expect(document).toContain("(Tests and the UI lane gate the release.) Tj");
      expect(document).toContain("(Gate summary) Tj");
      expect(document).toContain("(pnpm test) Tj");
      // CJK bodies travel through the CID font as UCS-2 hex.
      expect(document).toContain("/Encoding /UniGB-UCS2-H");
      expect(document).toContain(
        Array.from("请把发布清单整理成")
          .map((char) => char.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0"))
          .join(""),
      );
      // Thinking and tool output never reach the export.
      expect(document).not.toContain(thinkingText);
      expect(document).not.toContain(toolOutput);
      const requests = await gateway.getRequests("chat.history");
      expect(
        requests.filter((request) => Number((request.params as { limit?: number }).limit) === 1000)
          .length,
      ).toBeGreaterThan(1);

      if (suite.artifactDir) {
        await writeFile(path.join(suite.artifactDir, "pdf-export.pdf"), bytes);
      }
      await captureUiProof(suite, page, "pdf-export-after.png");
    });
  });

  it("offers the export from the compact session menu on a phone viewport", async () => {
    await suite.withPage({ viewport: { width: 420, height: 860 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        sessionKey,
        featureMethods: ["chat.metadata", "chat.startup", "chat.history"],
        historyMessages: history.slice(0, 2),
        methodResponses: {
          "sessions.list": sessionsListResponse([
            sessionRow(sessionKey, "Release planning", Date.parse("2026-11-17T06:00:00Z")),
          ]),
        },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      await gateway.waitForRequest("chat.startup");
      const pane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
      const menu = pane
        .locator("openclaw-chat-header-session-menu")
        .filter({ has: page.locator("wa-dropdown.chat-header-session-menu--compact") });
      await pane.locator(".chat-header-session-menu__trigger").first().click();
      const action = menu.locator('wa-dropdown-item[value="export-pdf"]');
      await action.waitFor({ state: "visible" });
      await captureUiProof(suite, page, "pdf-export-compact-menu.png");
    });
  });

  it("reports an empty conversation instead of writing an empty PDF", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        sessionKey,
        featureMethods: ["chat.metadata", "chat.startup", "chat.history"],
        historyMessages: [{ role: "toolResult", toolCallId: "only-tool", content: toolOutput }],
        methodResponses: {
          "sessions.list": sessionsListResponse([
            sessionRow(sessionKey, "Release planning", Date.parse("2026-11-17T06:00:00Z")),
          ]),
        },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      await gateway.waitForRequest("chat.startup");
      const downloads: string[] = [];
      page.on("download", (download) => downloads.push(download.suggestedFilename()));

      const exportAction = await openPdfExportAction(page);
      await exportAction.click();
      await page.getByText("There are no messages to export yet.", { exact: true }).waitFor();
      expect(downloads).toEqual([]);
    });
  });

  it("never attributes a late export to the session the operator switched to", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        sessionKey,
        featureMethods: ["chat.metadata", "chat.startup", "chat.history"],
        historyMessages: history,
        methodResponses: {
          "sessions.list": sessionsListResponse([
            sessionRow(sessionKey, "Release planning", Date.parse("2026-11-17T06:00:00Z")),
            sessionRow(otherSessionKey, "Other session", Date.parse("2026-11-17T05:00:00Z")),
          ]),
        },
        sessionTranscripts: {
          [otherSessionKey]: { messages: [{ role: "user", content: "Other session body" }] },
        },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      await gateway.waitForRequest("chat.startup");
      await page.evaluate(() => {
        const mockGateway = (
          window as unknown as {
            openclawControlUiE2eGateway: {
              setRequestHandler: (
                method: string,
                handler: (context: {
                  params: unknown;
                  respond: (payload: unknown) => void;
                }) => void,
              ) => void;
            };
          }
        ).openclawControlUiE2eGateway;
        let releaseHeldPage: (() => void) | null = null;
        let markHeldPageRequested: (() => void) | null = null;
        const heldPageRequested = new Promise<void>((resolve) => {
          markHeldPageRequested = resolve;
        });
        const heldPageRelease = new Promise<void>((resolve) => {
          releaseHeldPage = resolve;
        });
        const host = window as unknown as {
          openclawPdfHeldPageRequested?: Promise<void>;
          openclawReleasePdfPage?: () => void;
        };
        // Explicit deferred signals: the test awaits the request and drives the release
        // through the page, so no fixed sleep or polling is involved.
        host.openclawPdfHeldPageRequested = heldPageRequested;
        host.openclawReleasePdfPage = () => releaseHeldPage?.();
        mockGateway.setRequestHandler("chat.history", ({ params, respond }) => {
          const query = (params ?? {}) as { offset?: number; limit?: number; sessionKey?: string };
          const offset = typeof query.offset === "number" ? query.offset : 0;
          const other = query.sessionKey?.endsWith("pdf-export-other") === true;
          const exportRead = !other && query.limit === 1000;
          const answer = (hasMore: boolean) =>
            respond({
              sessionId: other
                ? "session:agent:main:pdf-export-other"
                : "session:agent:main:pdf-export",
              messages: [
                other
                  ? { role: "user", content: "Other session body" }
                  : { role: "user", content: "Which checks gate the release?" },
              ],
              totalMessages: 2,
              hasMore,
              ...(hasMore ? { nextOffset: offset + 1 } : {}),
              deltaCursor: "pdf-export-cursor",
              sessionInfo: { activeLeafEntryId: "pdf-export-leaf" },
            });
          if (!exportRead) {
            answer(false);
            return;
          }
          if (offset === 0) {
            answer(true);
            return;
          }
          // Hold the export's second page until the test releases it after switching.
          markHeldPageRequested?.();
          void heldPageRelease.then(() => answer(false));
        });
      });

      const seenDownloads: string[] = [];
      page.on("download", (download) => seenDownloads.push(download.suggestedFilename()));
      const exportAction = await openPdfExportAction(page);
      await exportAction.click();
      // Deterministic wait for the export's held second page, then switch away.
      await page.evaluate(
        () =>
          (window as unknown as { openclawPdfHeldPageRequested?: Promise<void> })
            .openclawPdfHeldPageRequested,
      );
      await page
        .locator('.sidebar-recent-session[data-session-key="' + otherSessionKey + '"]')
        .click();
      await page
        .locator('openclaw-chat-pane[aria-hidden="false"]')
        .getByText("Other session body", { exact: true })
        .waitFor();
      await page.evaluate(() => {
        (window as unknown as { openclawReleasePdfPage?: () => void }).openclawReleasePdfPage?.();
      });

      // Settlement signal from the real flow: exporting the session now on screen can
      // only start once the retired export cleared the pane's in-flight guard. If the
      // old export were still pending, this click would be refused and no download
      // would arrive.
      const currentPaneDownload = page.waitForEvent("download");
      const otherExportAction = await openPdfExportAction(page);
      await otherExportAction.click();
      const download = await currentPaneDownload;
      const stream = await download.createReadStream();
      const chunks: Buffer[] = [];
      for await (const chunk of stream ?? []) {
        chunks.push(Buffer.from(chunk as Uint8Array));
      }
      const pdf = new TextDecoder("latin1").decode(new Uint8Array(Buffer.concat(chunks)));

      // Exactly one download exists: the export of the session now on screen. The
      // retired export produced none, and it had already settled because the pane
      // refuses a new export while one is still running.
      expect(seenDownloads).toEqual([download.suggestedFilename()]);
      expect(pdf).toContain("(Other session body) Tj");
      expect(pdf).not.toContain("Which checks gate the release?");
    });
  });
});
