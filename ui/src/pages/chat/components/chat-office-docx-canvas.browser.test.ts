import { expect, it } from "vitest";
import "../../../styles.css";
import "../../../styles/chat.ts";
import "../../../styles/chat/side-panel.css";
import "./chat-office-preview-element.ts";

const browserMode = "__vitest_browser__" in globalThis;

type DocxPage = {
  widthPt: number;
  heightPt: number;
  marginTopPt: number;
  marginRightPt: number;
  marginBottomPt: number;
  marginLeftPt: number;
  blocks: {
    kind: "paragraph";
    role: "body";
    text: string;
    runs: { text: string; fontSizePt: number }[];
  }[];
};

function page(widthPt: number, heightPt: number, lines: string[]): DocxPage {
  return {
    widthPt,
    heightPt,
    marginTopPt: 72,
    marginRightPt: 72,
    marginBottomPt: 72,
    marginLeftPt: 72,
    blocks: lines.map((text) => ({
      kind: "paragraph" as const,
      role: "body" as const,
      text,
      runs: [{ text, fontSizePt: 11 }],
    })),
  };
}

function longParagraphs(label: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${label} paragraph ${index + 1}.`);
}

/** Authored CSS pixels of one page's declared size. */
const PAGE_PX_PER_PT = 4 / 3;
const A4_WIDTH_PX = Math.round(595.3 * PAGE_PX_PER_PT);
const LETTER_WIDTH_PX = Math.round(612 * PAGE_PX_PER_PT);
const LETTER_LANDSCAPE_WIDTH_PX = Math.round(792 * PAGE_PX_PER_PT);
/** One 11pt line at the document's 1.35 line height, in layout pixels. */
const LINE_BOX_PX = 11 * PAGE_PX_PER_PT * 1.35;

async function waitForSettledCards(viewer: HTMLElement, count: number) {
  await expect
    .poll(
      () =>
        renderedCards(viewer) === count && !viewer.querySelector(".sidebar-office-docx__measure")
          ? 1
          : 0,
      { timeout: 5_000 },
    )
    .toBe(1);
}

function mountViewer() {
  const panel = document.createElement("div");
  panel.className = "side-panel__panel";
  panel.style.cssText = "display:flex;flex-direction:column;width:420px;height:640px;";
  const content = document.createElement("div");
  content.className = "sidebar-content";
  const host = document.createElement("div");
  host.className = "sidebar-office-preview-host";
  const viewer = document.createElement("openclaw-chat-office-preview");
  host.append(viewer);
  content.append(host);
  panel.append(content);
  document.body.append(panel);
  return { panel, viewer };
}

/** Largest overflow of any rendered page body, in layout pixels. */
function bodyOverflow(viewer: HTMLElement): number {
  const bodies = [...viewer.querySelectorAll<HTMLElement>(".sidebar-office-docx__page-body")];
  return Math.max(0, ...bodies.map((body) => body.scrollHeight - body.clientHeight));
}

function renderedCards(viewer: HTMLElement): number {
  return viewer.querySelectorAll(".sidebar-office-docx__page").length;
}

/** Wait for the measured layout: several cards, no measuring stage, marker text. */
async function waitForPagination(viewer: HTMLElement, marker: string) {
  await expect
    .poll(
      () =>
        renderedCards(viewer) > 1 &&
        !viewer.querySelector(".sidebar-office-docx__measure") &&
        (viewer.textContent ?? "").includes(marker)
          ? renderedCards(viewer)
          : 0,
      { timeout: 5_000 },
    )
    .toBeGreaterThan(1);
}

it.skipIf(!browserMode)("re-paginates a document assigned to a live preview element", async () => {
  const { panel, viewer } = mountViewer();
  try {
    viewer.preview = {
      format: "docx",
      pages: [page(595.3, 841.9, longParagraphs("First document", 180))],
    };
    await expect
      .poll(() => (renderedCards(viewer) > 1 ? renderedCards(viewer) : 0), { timeout: 5_000 })
      .toBeGreaterThan(1);
    await expect.poll(() => viewer.querySelector(".sidebar-office-docx__measure")).toBeNull();
    expect(bodyOverflow(viewer)).toBeLessThanOrEqual(2);

    // Switching between already-open Office tabs keeps the same element.
    viewer.preview = {
      format: "docx",
      pages: [page(595.3, 841.9, longParagraphs("Second document", 180))],
    };
    await waitForPagination(viewer, "Second document paragraph 180");
    expect(viewer.textContent).not.toContain("First document");
    expect(bodyOverflow(viewer)).toBeLessThanOrEqual(2);
  } finally {
    panel.remove();
  }
});

it.skipIf(!browserMode)(
  "fits width to the widest page of a mixed-orientation document",
  async () => {
    const { panel, viewer } = mountViewer();
    try {
      viewer.preview = {
        format: "docx",
        pages: [
          page(595.3, 841.9, longParagraphs("Portrait", 3)),
          page(841.9, 595.3, longParagraphs("Landscape", 2)),
        ],
      };
      await expect
        .poll(() => (renderedCards(viewer) === 2 ? renderedCards(viewer) : 0), { timeout: 5_000 })
        .toBe(2);
      await expect.poll(() => viewer.querySelector(".sidebar-office-docx__measure")).toBeNull();

      const scroller = viewer.querySelector<HTMLElement>(".sidebar-office-docx__scroll")!;
      const scale = Number.parseFloat(
        getComputedStyle(scroller).getPropertyValue("--office-canvas-scale"),
      );
      const widestCanvas = Math.round((841.9 * 4) / 3);
      // One scale drives every card, so it must follow the widest page.
      expect(scale).toBeCloseTo((scroller.clientWidth - 8) / widestCanvas, 2);
      const widths = [...viewer.querySelectorAll<HTMLElement>(".sidebar-office-docx__page")].map(
        (card) => card.getBoundingClientRect().width,
      );
      expect(widths[1]!).toBeGreaterThan(widths[0]!);
      for (const width of widths) {
        expect(width).toBeLessThanOrEqual(scroller.clientWidth + 1);
      }
    } finally {
      panel.remove();
    }
  },
);

it.skipIf(!browserMode)("paginates a document assigned while the reader is hidden", async () => {
  const { panel, viewer } = mountViewer();
  try {
    // A minimized or inactive side panel keeps its reader at display: none
    // while the preview payload arrives.
    panel.style.display = "none";
    viewer.preview = {
      format: "docx",
      pages: [page(595.3, 841.9, longParagraphs("Hidden document", 180))],
    };
    await expect
      .poll(() => (viewer.querySelector(".sidebar-office-docx__measure") ? 1 : 0), {
        timeout: 5_000,
      })
      .toBe(1);

    panel.style.display = "";
    await waitForPagination(viewer, "Hidden document paragraph 180");
    expect(bodyOverflow(viewer)).toBeLessThanOrEqual(2);
  } finally {
    panel.remove();
  }
});

it.skipIf(!browserMode)(
  "paginates a second document assigned while the reader is hidden",
  async () => {
    const { panel, viewer } = mountViewer();
    try {
      viewer.preview = {
        format: "docx",
        pages: [page(595.3, 841.9, longParagraphs("First document", 180))],
      };
      await waitForPagination(viewer, "First document paragraph 180");

      panel.style.display = "none";
      viewer.preview = {
        format: "docx",
        pages: [page(595.3, 841.9, longParagraphs("Second document", 180))],
      };
      await expect
        .poll(() => (viewer.querySelector(".sidebar-office-docx__measure") ? 1 : 0), {
          timeout: 5_000,
        })
        .toBe(1);

      panel.style.display = "";
      await waitForPagination(viewer, "Second document paragraph 180");
      expect(viewer.textContent).not.toContain("First document");
      expect(bodyOverflow(viewer)).toBeLessThanOrEqual(2);
    } finally {
      panel.remove();
    }
  },
);

it.skipIf(!browserMode)("keeps only the newest preview across rapid switches", async () => {
  const { panel, viewer } = mountViewer();
  try {
    viewer.preview = {
      format: "docx",
      pages: [page(595.3, 841.9, longParagraphs("Discarded document", 180))],
    };
    viewer.preview = {
      format: "docx",
      pages: [page(595.3, 841.9, longParagraphs("Final document", 180))],
    };
    await waitForPagination(viewer, "Final document paragraph 180");
    expect(viewer.textContent).not.toContain("Discarded document");
    expect(bodyOverflow(viewer)).toBeLessThanOrEqual(2);
  } finally {
    panel.remove();
  }
});

it.skipIf(!browserMode)(
  "reserves each page's authored box for non-A4 sizes at fit width",
  async () => {
    const { panel, viewer } = mountViewer();
    try {
      viewer.preview = {
        format: "docx",
        pages: [
          page(595.3, 841.9, longParagraphs("A4", 2)),
          page(612, 792, longParagraphs("Letter", 2)),
          page(792, 612, longParagraphs("Landscape", 2)),
        ],
      };
      await waitForSettledCards(viewer, 3);

      const scroller = viewer.querySelector<HTMLElement>(".sidebar-office-docx__scroll")!;
      const scale = Number.parseFloat(
        getComputedStyle(scroller).getPropertyValue("--office-canvas-scale"),
      );
      // The widest page (Landscape Letter) drives the single fit scale, so every
      // reserved box must fit the reader without a horizontal scrollbar.
      expect(scroller.scrollWidth).toBeLessThanOrEqual(scroller.clientWidth + 1);

      const cards = [...viewer.querySelectorAll<HTMLElement>(".sidebar-office-docx__page")];
      const canvases = [A4_WIDTH_PX, LETTER_WIDTH_PX, LETTER_LANDSCAPE_WIDTH_PX];
      for (const [index, card] of cards.entries()) {
        const scaler = card.parentElement!;
        expect(scaler.classList.contains("sidebar-office-docx__page-scaler")).toBe(true);
        const cardRect = card.getBoundingClientRect();
        const scalerRect = scaler.getBoundingClientRect();
        // The page keeps its authored canvas width and the scaler reserves it.
        expect(cardRect.width).toBeCloseTo(canvases[index]! * scale, 0);
        expect(scalerRect.width).toBeCloseTo(cardRect.width, 0);
        expect(scalerRect.height).toBeCloseTo(cardRect.height, 0);
      }
      // Declared page shapes survive the scale: portrait Letter is 816x1056.
      expect(cards[1]!.getBoundingClientRect().width).toBeGreaterThan(
        cards[0]!.getBoundingClientRect().width,
      );
      expect(cards[2]!.getBoundingClientRect().width).toBeGreaterThan(
        cards[1]!.getBoundingClientRect().width,
      );
      expect(
        cards[2]!.getBoundingClientRect().width / cards[2]!.getBoundingClientRect().height,
      ).toBeCloseTo(792 / 612, 1);
    } finally {
      panel.remove();
    }
  },
);

it.skipIf(!browserMode)("keeps a one-line paragraph to a single line box", async () => {
  const { panel, viewer } = mountViewer();
  try {
    viewer.preview = {
      format: "docx",
      pages: [page(595.3, 841.9, ["Single authored line", "Alpha\nBeta"])],
    };
    await waitForSettledCards(viewer, 1);

    const paragraphs = [
      ...viewer.querySelectorAll<HTMLElement>(".sidebar-office-docx__page [data-role='body']"),
    ];
    expect(paragraphs).toHaveLength(2);
    const single = paragraphs[0]!;
    const broken = paragraphs[1]!;
    // Template indentation must not become blank lines before the authored text.
    expect(single.offsetHeight).toBeLessThanOrEqual(Math.round(LINE_BOX_PX * 1.5));
    const text = single.querySelector<HTMLElement>(".sidebar-office-docx__text")!;
    expect(
      text.getBoundingClientRect().top - single.getBoundingClientRect().top,
    ).toBeLessThanOrEqual(2);
    // An authored line break still renders as a second line.
    expect(broken.textContent).toContain("Alpha\nBeta");
    expect(broken.offsetHeight).toBeGreaterThan(Math.round(LINE_BOX_PX * 1.5));
    expect(broken.offsetHeight).toBeLessThan(Math.round(LINE_BOX_PX * 2.5));
  } finally {
    panel.remove();
  }
});
