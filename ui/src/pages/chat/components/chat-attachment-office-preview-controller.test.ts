import { Blob as NodeBlob } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import type { ArtifactOfficePreview } from "../../../api/artifact-download.ts";
import "./chat-detail-panel.ts";
import type { AttachmentSidebarContent, SidebarContent } from "./chat-sidebar-content-types.ts";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function officeAttachment(
  label: string,
  load: (signal: AbortSignal) => Promise<ArtifactOfficePreview | null>,
): AttachmentSidebarContent {
  return {
    kind: "attachment",
    attachmentKind: "document",
    title: label,
    mimeType: XLSX_MIME,
    office: { format: "xlsx", load },
  };
}

function readyPreview(): ArtifactOfficePreview {
  return {
    kind: "office",
    format: "xlsx",
    state: "ready",
    preview: {
      format: "xlsx",
      sheets: [{ name: "Budget", rowCount: 1, columnCount: 1, rows: [["Rent"]] }],
    },
  };
}

function createPanel() {
  const panel = document.createElement("openclaw-chat-detail-panel") as HTMLElement & {
    content: SidebarContent;
    attachmentRuntime: { connectionEpoch?: number; sessionKey?: string };
    updateComplete: Promise<unknown>;
  };
  panel.attachmentRuntime = { connectionEpoch: 1, sessionKey: "agent:main:main" };
  document.body.append(panel);
  return panel;
}

describe("attachment office preview controller transitions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.textContent = "";
  });

  it("shows the loading state on the initial open before the payload settles", async () => {
    // jsdom's Blob lacks arrayBuffer; the ready viewer reads preview bytes.
    vi.stubGlobal("Blob", NodeBlob);
    const deferred = createDeferred<ArtifactOfficePreview>();
    const panel = createPanel();
    try {
      panel.content = officeAttachment("budget.xlsx", () => deferred.promise);
      await panel.updateComplete;
      await vi.waitFor(() =>
        expect(panel.querySelector(".sidebar-office-preview__state[role='status']")).toBeTruthy(),
      );
      expect(panel.querySelector("openclaw-chat-office-preview")).toBeNull();

      deferred.resolve(readyPreview());
      await vi.waitFor(() =>
        expect(panel.querySelector("openclaw-chat-office-preview")).toBeTruthy(),
      );
      expect(panel.querySelector(".sidebar-office-preview__state")).toBeNull();
    } finally {
      panel.remove();
    }
  });

  it("replaces a ready preview with loading while the next attachment parses", async () => {
    vi.stubGlobal("Blob", NodeBlob);
    const first = createDeferred<ArtifactOfficePreview>();
    const panel = createPanel();
    try {
      panel.content = officeAttachment("budget.xlsx", () => first.promise);
      first.resolve(readyPreview());
      await vi.waitFor(() =>
        expect(panel.querySelector("openclaw-chat-office-preview")).toBeTruthy(),
      );

      const second = createDeferred<ArtifactOfficePreview>();
      panel.content = officeAttachment(
        "roadmap.pptx",
        (signal) =>
          // Keep the delayed request observable so stale content has time to leak.
          new Promise((resolve) => {
            signal.addEventListener("abort", () => resolve(null), { once: true });
            void second.promise.then((value) => resolve(value));
          }),
      );
      await panel.updateComplete;
      // The newly selected attachment renders loading, never the prior document.
      await vi.waitFor(() =>
        expect(panel.querySelector(".sidebar-office-preview__state[role='status']")).toBeTruthy(),
      );
      expect(panel.querySelector("openclaw-chat-office-preview")).toBeNull();

      second.resolve({
        kind: "office",
        format: "pptx",
        state: "ready",
        preview: {
          format: "pptx",
          slides: [{ index: 1, lines: ["Ship"] }],
        },
      });
      await vi.waitFor(() =>
        expect(panel.querySelector("openclaw-chat-office-preview")).toBeTruthy(),
      );
    } finally {
      panel.remove();
    }
  });

  it("aborts the previous attachment's in-flight load on selection change", async () => {
    const panel = createPanel();
    let observedSignal: AbortSignal | undefined;
    const first = createDeferred<ArtifactOfficePreview | null>();
    panel.content = officeAttachment("budget.xlsx", (signal) => {
      observedSignal = signal;
      return first.promise;
    });
    await vi.waitFor(() => expect(observedSignal).toBeTruthy());

    panel.content = officeAttachment("roadmap.pptx", () =>
      Promise.resolve({ kind: "office", state: "unsupported" }),
    );
    await panel.updateComplete;
    expect(observedSignal?.aborted).toBe(true);
    panel.remove();
  });
});
