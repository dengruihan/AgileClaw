/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import {
  flushAttachmentResolution,
  managedAttachment,
  registerChatAttachmentTestCleanup,
  renderAssistantAttachments,
} from "./chat-message-attachments.test-support.ts";

const subscribers = registerChatAttachmentTestCleanup();

describe("click-time attachment download reauthorization", () => {
  it("prefixes a freshly minted managed ticket with the Control UI resource base path", async () => {
    const attachmentId = crypto.randomUUID();
    const source = `/api/chat/media/outgoing/agent%3Amain%3Amain/${attachmentId}/full`;
    const ticketedUrl = `${source}?mediaTicket=ticket`;
    const resolveArtifactDownload = vi.fn(async () => ({ url: ticketedUrl }));
    const container = document.body.appendChild(document.createElement("div"));
    const rerender = () =>
      render(
        renderAssistantAttachments([managedAttachment(source, `artifact_${attachmentId}`)], {
          onRequestUpdate: rerender,
          resourceBasePath: "/rosita",
          resolveArtifactDownload,
        }),
        container,
      );
    subscribers.add(rerender);

    rerender();
    await vi.waitFor(() =>
      expect(
        container.querySelector("button.chat-assistant-attachment-card__download:not([disabled])"),
      ).not.toBeNull(),
    );

    const downloadClick = vi.spyOn(HTMLAnchorElement.prototype, "click");
    container
      .querySelector<HTMLButtonElement>(
        "button.chat-assistant-attachment-card__download:not([disabled])",
      )
      ?.click();
    await flushAttachmentResolution();
    expect((downloadClick.mock.instances[0] as HTMLAnchorElement | undefined)?.href).toContain(
      `/rosita${ticketedUrl}`,
    );
    downloadClick.mockRestore();
    container.remove();
  });

  it("mints a fresh assistant-media ticket when a local attachment download is clicked", async () => {
    const source = `/tmp/openclaw/${crypto.randomUUID()}.pdf`;
    const ticket = (name: string) =>
      Response.json({
        available: true,
        mediaTicket: name,
        mediaTicketExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(ticket("original"))
      .mockResolvedValueOnce(ticket("fresh"));
    vi.stubGlobal("fetch", fetchMock);
    const container = document.body.appendChild(document.createElement("div"));
    const rerender = () =>
      render(
        renderAssistantAttachments(
          [
            {
              type: "attachment",
              attachment: {
                kind: "document",
                label: "report.pdf",
                mimeType: "application/pdf",
                url: source,
              },
            },
          ],
          { onRequestUpdate: rerender },
        ),
        container,
      );
    subscribers.add(rerender);

    rerender();
    const enabledDownload = () =>
      container.querySelector<HTMLButtonElement>(
        "button.chat-assistant-attachment-card__download:not([disabled])",
      );
    await vi.waitFor(() => expect(enabledDownload()).not.toBeNull());

    const downloadClick = vi.spyOn(HTMLAnchorElement.prototype, "click");
    enabledDownload()?.click();
    await vi.waitFor(() => expect(downloadClick).toHaveBeenCalledOnce());

    const savedAnchor = downloadClick.mock.instances[0] as HTMLAnchorElement | undefined;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(savedAnchor?.href).toContain("/__openclaw__/assistant-media");
    expect(savedAnchor?.href).toContain("mediaTicket=fresh");
    expect(savedAnchor?.getAttribute("download")).toBe("report.pdf");
    downloadClick.mockRestore();
    container.remove();
  });

  it("keeps a failed download free of broken navigation and retryable by clicking again", async () => {
    const attachmentId = crypto.randomUUID();
    const artifactId = `artifact_managed_document_${attachmentId}`;
    const source = `/api/chat/media/outgoing/agent%3Amain%3Amain/${attachmentId}/full`;
    const resolveArtifactDownload = vi
      .fn<() => Promise<{ url: string } | null>>()
      .mockResolvedValueOnce({ url: `${source}?mediaTicket=stale` })
      .mockRejectedValueOnce(new Error("gateway unavailable"))
      .mockResolvedValueOnce({ url: `${source}?mediaTicket=fresh` });
    const container = document.body.appendChild(document.createElement("div"));
    const rerender = () =>
      render(
        renderAssistantAttachments([managedAttachment(source, artifactId)], {
          onRequestUpdate: rerender,
          resolveArtifactDownload,
        }),
        container,
      );
    subscribers.add(rerender);

    rerender();
    const enabledDownload = () =>
      container.querySelector<HTMLButtonElement>(
        "button.chat-assistant-attachment-card__download:not([disabled])",
      );
    await vi.waitFor(() => {
      expect(resolveArtifactDownload).toHaveBeenCalledTimes(1);
      expect(enabledDownload()).not.toBeNull();
    });
    const downloadClick = vi.spyOn(HTMLAnchorElement.prototype, "click");
    const clickDownload = () => enabledDownload()?.click();

    clickDownload();
    await flushAttachmentResolution();
    expect(downloadClick).not.toHaveBeenCalled();

    clickDownload();
    await flushAttachmentResolution();
    expect(downloadClick).toHaveBeenCalledOnce();
    expect((downloadClick.mock.instances[0] as HTMLAnchorElement | undefined)?.href).toContain(
      "mediaTicket=fresh",
    );
    downloadClick.mockRestore();
    container.remove();
  });
});
