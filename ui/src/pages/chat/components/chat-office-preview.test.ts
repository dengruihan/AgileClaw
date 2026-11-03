/* @vitest-environment jsdom */

import { afterEach, expect, it } from "vitest";
import type { SessionFileOfficePreview } from "../../../../../packages/gateway-protocol/src/schema/sessions.js";
import type { SidebarContent } from "./chat-sidebar-content-types.ts";
import "./chat-detail-panel.ts";

type DetailPanel = HTMLElement & {
  content: Extract<SidebarContent, { kind: "office" }>;
  updateComplete: Promise<unknown>;
};

async function mountOffice(
  content: Partial<Extract<SidebarContent, { kind: "office" }>> & {
    preview: SessionFileOfficePreview;
  },
) {
  const panel = document.createElement("openclaw-chat-detail-panel") as DetailPanel;
  panel.content = { kind: "office", title: "budget.xlsx", ...content };
  document.body.append(panel);
  await panel.updateComplete;
  await expect
    .poll(() => panel.querySelector("openclaw-chat-office-preview")?.children.length ?? 0)
    .toBeGreaterThan(0);
  return panel;
}

afterEach(() => {
  document.body.replaceChildren();
});

it("renders workbook rows and switches worksheets", async () => {
  const panel = await mountOffice({
    preview: {
      format: "xlsx",
      sheets: [
        {
          name: "Budget",
          rows: [
            ["Item", "Cost"],
            ["Rent", "1200"],
          ],
          rowCount: 2,
          columnCount: 2,
        },
        { name: "Notes", rows: [["Hello"]], rowCount: 1, columnCount: 1 },
      ],
    },
  });

  const viewer = panel.querySelector("openclaw-chat-office-preview")!;
  expect(viewer).not.toBeNull();
  expect(viewer.querySelector("table")?.textContent).toContain("Rent");
  const tabs = [...viewer.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  expect(tabs.map((tab) => tab.textContent?.trim())).toEqual(["Budget", "Notes"]);
  expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");

  tabs[1]?.click();
  await panel.updateComplete;
  await viewer.updateComplete;

  expect(viewer.querySelector("table")?.textContent).toContain("Hello");
  expect(tabs[1]?.getAttribute("aria-selected")).toBe("true");
});

it("renders document headings, paragraphs, and list items", async () => {
  const panel = await mountOffice({
    title: "report.docx",
    preview: {
      format: "docx",
      blocks: [
        { kind: "heading", level: 2, text: "Quarterly report" },
        { kind: "paragraph", text: "Revenue grew" },
        { kind: "listItem", text: "First point" },
        { kind: "listItem", text: "Second point" },
      ],
    },
  });

  const viewer = panel.querySelector("openclaw-chat-office-preview")!;
  expect(viewer.querySelector('[role="heading"]')?.getAttribute("aria-level")).toBe("2");
  expect(viewer.querySelectorAll("ul li")).toHaveLength(2);
  expect(viewer.textContent).toContain("Revenue grew");
});

it("renders slide outlines", async () => {
  const panel = await mountOffice({
    title: "deck.pptx",
    preview: {
      format: "pptx",
      slides: [
        { index: 1, title: "Roadmap", lines: ["Ship previews"] },
        { index: 2, lines: ["No title slide"] },
      ],
    },
  });

  const viewer = panel.querySelector("openclaw-chat-office-preview")!;
  const slides = [...viewer.querySelectorAll("[data-slide-index]")];
  expect(slides).toHaveLength(2);
  expect(slides[0]?.textContent).toContain("Roadmap");
  expect(slides[1]?.textContent).toContain("Slide 2");
});

it("shows truncation and empty states", async () => {
  const truncated = await mountOffice({
    preview: { format: "docx", blocks: [{ kind: "paragraph", text: "Partial" }], truncated: true },
  });
  expect(truncated.textContent).toContain("truncated");

  document.body.replaceChildren();
  const empty = await mountOffice({ preview: { format: "xlsx", sheets: [] } });
  expect(empty.textContent).toContain("no previewable content");
});
