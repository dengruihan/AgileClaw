/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import type { SidebarContent } from "./chat-sidebar-content-types.ts";
import "./chat-detail-panel.ts";

type DetailPanel = HTMLElement & {
  content: Extract<SidebarContent, { kind: "office" }>;
  updateComplete: Promise<unknown>;
};

const PDF_BASE64 = btoa("%PDF-1.7\nconverted");
const PDF_BYTES = 18;

function stubObjectUrls() {
  const NativeURL = URL;
  class TestURL extends NativeURL {}
  const createObjectURL = vi.fn(() => "blob:office-pdf");
  Object.defineProperty(TestURL, "createObjectURL", { value: createObjectURL });
  Object.defineProperty(TestURL, "revokeObjectURL", { value: vi.fn() });
  vi.stubGlobal("URL", TestURL);
  return { createObjectURL };
}

async function mountOffice(overrides: Partial<Extract<SidebarContent, { kind: "office" }>> = {}) {
  const panel = document.createElement("openclaw-chat-detail-panel") as DetailPanel;
  panel.content = {
    kind: "office",
    title: "budget.xlsx",
    pdf: { mimeType: "application/pdf", data: PDF_BASE64, sizeBytes: PDF_BYTES },
    ...overrides,
  };
  document.body.append(panel);
  await panel.updateComplete;
  const preview = panel.querySelector("openclaw-chat-pdf-preview") as
    | (HTMLElement & { updateComplete: Promise<unknown> })
    | null;
  await preview?.updateComplete;
  return { panel, preview };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it("renders the converted PDF in the shared browser reader without a fetch", async () => {
  stubObjectUrls();
  const fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
  const { panel, preview } = await mountOffice();

  await vi.waitFor(() => expect(panel.querySelector("iframe")).not.toBeNull());
  const frame = panel.querySelector<HTMLIFrameElement>("iframe")!;
  expect(preview?.getAttribute("label")).toBeNull();
  expect(frame.className).toBe("sidebar-pdf-preview__frame");
  expect(frame.getAttribute("src")).toBe("blob:office-pdf");
  expect(frame.title).toBe("budget.xlsx");
  expect(fetchMock).not.toHaveBeenCalled();
});

it("keeps the explicit original-file download beside the PDF reader", async () => {
  stubObjectUrls();
  const onDownload = vi.fn();
  const { panel } = await mountOffice({ downloadNow: onDownload });

  const button = panel.querySelector<HTMLButtonElement>("button.sidebar-office-preview__download");
  await vi.waitFor(() => expect(button).not.toBeNull());
  expect(button!.getAttribute("aria-label")).toBe("Download budget.xlsx");
  expect(panel.querySelector("a[download]")).toBeNull();
  button!.click();
  expect(onDownload).toHaveBeenCalledOnce();
});

it("replaces the reader when a different Office file is selected", async () => {
  const urls = stubObjectUrls();
  const { panel } = await mountOffice();
  await vi.waitFor(() => expect(panel.querySelector("iframe")).not.toBeNull());

  panel.content = {
    kind: "office",
    title: "report.docx",
    pdf: {
      mimeType: "application/pdf",
      data: btoa("%PDF-1.7\nother"),
      sizeBytes: 16,
    },
  };
  await panel.updateComplete;
  const preview = panel.querySelector("openclaw-chat-pdf-preview") as HTMLElement & {
    updateComplete: Promise<unknown>;
  };
  await preview.updateComplete;
  await vi.waitFor(() => expect(panel.querySelector("iframe")?.title).toBe("report.docx"));
  expect(urls.createObjectURL).toHaveBeenCalledTimes(2);
});
