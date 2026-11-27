import { expect, it } from "vitest";
import "../../../styles.css";
import "../../../styles/chat.ts";
import "../../../styles/chat/side-panel.css";
import "./chat-office-preview-element.ts";

const browserMode = "__vitest_browser__" in globalThis;

it.skipIf(!browserMode)("keeps one fixed workbook grid across reader widths", async () => {
  // Mirror the production chain: the panel bounds the scroll host, which owns
  // the grid's own horizontal scrolling.
  const panel = document.createElement("div");
  panel.className = "side-panel__panel";
  panel.style.cssText = "display:flex;flex-direction:column;width:900px;height:640px;";
  const content = document.createElement("div");
  content.className = "sidebar-content";
  const host = document.createElement("div");
  host.className = "sidebar-office-preview-host";
  const viewer = document.createElement("openclaw-chat-office-preview");
  viewer.preview = {
    format: "xlsx",
    sheets: [
      {
        name: "Wrapped",
        rowCount: 2,
        columnCount: 2,
        columns: [{ width: 10 }, { width: 10 }],
        rows: [
          ["A long value that wraps across lines", "kept"],
          ["second", "row"],
        ],
        cells: [{ row: 0, column: 0, style: 0 }],
        styles: [{ wrapText: true }],
      },
    ],
  };
  host.append(viewer);
  content.append(host);
  panel.append(content);
  document.body.append(panel);

  const measure = () => {
    const table = viewer.querySelector<HTMLElement>(".sidebar-office-sheet__table")!;
    const cell = viewer.querySelector<HTMLElement>(
      '.sidebar-office-sheet__cell[data-row="0"][data-column="0"]',
    )!;
    const range = document.createRange();
    range.selectNodeContents(cell);
    return {
      columns: [...table.querySelectorAll("colgroup col")].map(
        (column) => getComputedStyle(column).width,
      ),
      lines: new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size,
      rowHeight: Math.round(cell.getBoundingClientRect().height),
    };
  };

  try {
    await viewer.updateComplete;
    await expect.poll(() => viewer.querySelector(".sidebar-office-sheet__table")).not.toBeNull();
    const wide = measure();
    // 10-character columns resolve to real Excel units, not reader pixels.
    expect(wide.columns).toEqual(["46px", "75px", "75px"]);

    for (const width of [440, 320, 260]) {
      panel.style.width = `${width}px`;
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
      const narrowed = measure();
      expect(narrowed.columns).toEqual(wide.columns);
      expect(narrowed.lines).toBe(wide.lines);
      expect(narrowed.rowHeight).toBe(wide.rowHeight);
    }

    // The grid keeps its own horizontal scroll instead of squeezing columns.
    const scroll = viewer.querySelector<HTMLElement>(".sidebar-office-sheet__scroll")!;
    expect(scroll.scrollWidth - scroll.clientWidth).toBeGreaterThan(0);
  } finally {
    panel.remove();
  }
});
