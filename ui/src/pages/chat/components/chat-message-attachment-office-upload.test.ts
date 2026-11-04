/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { render } from "lit";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  registerChatAttachmentTestCleanup,
  renderAssistantAttachments,
} from "./chat-message-attachments.test-support.ts";
import type { SidebarContent } from "./chat-sidebar-content-types.ts";

registerChatAttachmentTestCleanup();

type AttachmentSidebarContent = Extract<SidebarContent, { kind: "attachment" }>;

describe("office attachment previews", () => {
  it("requests an opt-in Office preview when a managed workbook attachment opens", async () => {
    const attachmentId = "11111111-1111-4111-8111-111111111111";
    const artifactId = `artifact_managed_media_${attachmentId}`;
    const source = `/api/chat/media/outgoing/agent%3Amain%3Amain/${attachmentId}/full`;
    const officePreview = {
      kind: "office",
      format: "xlsx",
      state: "ready",
      preview: {
        format: "xlsx",
        sheets: [{ name: "Budget", rowCount: 1, columnCount: 1, rows: [["Rent"]] }],
      },
    };
    const resolveArtifactDownload = vi.fn(
      async (params: { preview?: "office" } | { variant?: string }) =>
        "preview" in params && params.preview === "office"
          ? { preview: officePreview }
          : { url: `${source}?mediaTicket=ticket-workbook` },
    );
    const onOpenSidebar = vi.fn();
    const container = document.body.appendChild(document.createElement("div"));
    render(
      renderAssistantAttachments(
        [
          {
            type: "attachment",
            attachment: {
              kind: "document",
              label: "applications.xlsx",
              mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
              url: source,
              artifactId,
            },
          },
        ],
        { resolveArtifactDownload },
        onOpenSidebar,
      ),
      container,
    );

    const expand = await vi.waitFor(() =>
      expectDefined(
        container.querySelector<HTMLButtonElement>(".chat-assistant-attachment-card__expand"),
        "available workbook attachment",
      ),
    );
    expand.click();
    const content = onOpenSidebar.mock.calls.at(-1)?.[0] as AttachmentSidebarContent;
    expect(content.office?.format).toBe("xlsx");
    expect(content.downloadNow).toBeTypeOf("function");
    const preview = await content.office?.load(new AbortController().signal);
    expect(preview).toMatchObject({ kind: "office", format: "xlsx", state: "ready" });
    expect(resolveArtifactDownload).toHaveBeenCalledWith(
      { sessionKey: "agent:main:main", artifactId, preview: "office" },
      expect.any(AbortSignal),
    );
    container.remove();
  });

  it("keeps a legacy Office attachment metadata-only with an explicit download", async () => {
    const source = "/tmp/openclaw/ledger.xls";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              available: true,
              mediaTicket: "ticket-legacy",
              mediaTicketExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );
    const onOpenSidebar = vi.fn();
    const container = document.body.appendChild(document.createElement("div"));
    render(
      renderAssistantAttachments(
        [
          {
            type: "attachment",
            attachment: {
              kind: "document",
              label: "ledger.xls",
              mimeType: "application/vnd.ms-excel",
              url: source,
            },
          },
        ],
        {},
        onOpenSidebar,
      ),
      container,
    );

    const expand = await vi.waitFor(() =>
      expectDefined(
        container.querySelector<HTMLButtonElement>(".chat-assistant-attachment-card__expand"),
        "legacy attachment expand action",
      ),
    );
    expand.click();
    const content = onOpenSidebar.mock.calls.at(-1)?.[0] as AttachmentSidebarContent;
    expect(content.office).toBeUndefined();
    expect(content.previewNotice).toContain("Legacy Office");
    expect(content.downloadNow).toBeTypeOf("function");
    container.remove();
  });

  describe("optimistic office uploads", () => {
    it("previews an outbox workbook through the assistant-media upload parse", async () => {
      const dataUrl = `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${Buffer.from("PK-office-bytes").toString("base64")}`;
      const officePreview = {
        kind: "office",
        format: "xlsx",
        state: "ready",
        preview: {
          format: "xlsx",
          sheets: [{ name: "Budget", rowCount: 1, columnCount: 1, rows: [["Rent"]] }],
        },
      };
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof URL ? input.href : input;
        if (url === dataUrl) {
          return new Response(new Blob([Buffer.from("PK-office-bytes")]));
        }
        const parsed = new URL(url, "http://localhost");
        expect(parsed.pathname).toBe("/__openclaw__/assistant-media");
        expect(parsed.searchParams.get("meta")).toBe("1");
        expect(parsed.searchParams.get("preview")).toBe("office");
        expect(parsed.searchParams.get("upload")).toBe("1");
        expect(parsed.searchParams.get("filename")).toBe("budget.xlsx");
        expect(init?.method).toBe("POST");
        expect(init?.credentials).toBe("same-origin");
        expect(init?.body).toBeInstanceOf(Blob);
        return new Response(JSON.stringify({ available: true, officePreview }), {
          headers: { "Content-Type": "application/json" },
        });
      });
      vi.stubGlobal("fetch", fetchMock);
      const onOpenSidebar = vi.fn();
      const container = document.body.appendChild(document.createElement("div"));
      onTestFinished(() => container.remove());
      render(
        renderAssistantAttachments(
          [
            {
              type: "attachment",
              attachment: {
                kind: "document",
                label: "budget.xlsx",
                mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                url: dataUrl,
              },
            },
          ],
          {},
          onOpenSidebar,
        ),
        container,
      );

      const expand = await vi.waitFor(() =>
        expectDefined(
          container.querySelector<HTMLButtonElement>(".chat-assistant-attachment-card__expand"),
          "optimistic workbook attachment",
        ),
      );
      expand.click();
      const content = onOpenSidebar.mock.calls.at(-1)?.[0] as AttachmentSidebarContent;
      expect(content.office?.format).toBe("xlsx");
      // The retained client bytes back an explicit local download.
      expect(content.downloadNow).toBeTypeOf("function");
      const preview = await content.office?.load(new AbortController().signal);
      expect(preview).toMatchObject({ kind: "office", format: "xlsx", state: "ready" });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("maps an oversized upload to the too-large preview state", async () => {
      const dataUrl =
        "data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,UEs=";
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const url = input instanceof URL ? input.href : input;
          if (url === dataUrl) {
            return new Response(new Blob([Buffer.from("PK")]));
          }
          return new Response(
            JSON.stringify({
              available: false,
              reason: "Office preview payload too large",
              code: "office-preview-too-large",
            }),
            { headers: { "Content-Type": "application/json" } },
          );
        }),
      );
      const onOpenSidebar = vi.fn();
      const container = document.body.appendChild(document.createElement("div"));
      onTestFinished(() => container.remove());
      render(
        renderAssistantAttachments(
          [
            {
              type: "attachment",
              attachment: {
                kind: "document",
                label: "huge.xlsx",
                mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                url: dataUrl,
              },
            },
          ],
          {},
          onOpenSidebar,
        ),
        container,
      );
      const expand = await vi.waitFor(() =>
        expectDefined(
          container.querySelector<HTMLButtonElement>(".chat-assistant-attachment-card__expand"),
          "oversized workbook attachment",
        ),
      );
      expand.click();
      const content = onOpenSidebar.mock.calls.at(-1)?.[0] as AttachmentSidebarContent;
      const preview = await content.office?.load(new AbortController().signal);
      expect(preview).toEqual({ kind: "office", state: "too-large" });
    });
  });
});
