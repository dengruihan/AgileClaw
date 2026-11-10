function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function setPx(element: HTMLElement, property: "top" | "left", value: number | undefined): void {
  if (value === undefined) {
    element.style.removeProperty(property);
  } else {
    element.style.setProperty(property, `${value}px`);
  }
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/**
 * Measures the rendered frozen pane once per paint and writes sticky offsets
 * back onto the existing elements. Lit rendering owns the nominal fallbacks;
 * this controller only reconciles them with actual line-height, padding,
 * border, wrap, and font-driven row/column geometry.
 */
export class OfficeSheetGeometryController {
  private observer: ResizeObserver | null = null;
  private frame: number | null = null;
  private table: HTMLTableElement | null = null;
  private scroll: HTMLElement | null = null;
  private observing = false;

  constructor(private readonly host: HTMLElement) {}

  /** Rebind to the current sheet table after a render, sheet switch, or reconnect. */
  sync(): void {
    const table = this.host.querySelector<HTMLTableElement>(".sidebar-office-sheet__table");
    const scroll = table?.closest<HTMLElement>(".sidebar-office-sheet__scroll") ?? null;
    const needsObserver = Boolean(
      table &&
      scroll &&
      ((Number(table.dataset.frozenRows) || 0) > 0 ||
        (Number(table.dataset.frozenColumns) || 0) > 0),
    );
    if (table !== this.table || scroll !== this.scroll || needsObserver !== this.observing) {
      this.disconnectObserver();
      this.table = table;
      this.scroll = scroll;
      if (needsObserver && table && scroll && typeof ResizeObserver !== "undefined") {
        this.observer = new ResizeObserver(() => this.schedule());
        this.observer.observe(table);
        this.observer.observe(scroll);
        this.observing = true;
      }
    }
    this.measure();
  }

  disconnect(): void {
    this.disconnectObserver();
    this.table = null;
    this.scroll = null;
  }

  private disconnectObserver(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.observing = false;
    if (this.frame !== null) {
      if (typeof cancelAnimationFrame !== "undefined") {
        cancelAnimationFrame(this.frame);
      }
      this.frame = null;
    }
  }

  private schedule(): void {
    if (this.frame !== null) {
      return;
    }
    if (typeof requestAnimationFrame === "undefined") {
      this.measure();
      return;
    }
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.measure();
    });
  }

  private rowHeight(row: HTMLTableRowElement): number {
    let height = 0;
    for (const cell of row.cells) {
      if (cell.rowSpan > 1) {
        // A vertical merge spans several rows; the current row's height is
        // carried by its non-spanned cells or the row box itself.
        continue;
      }
      height = Math.max(height, cell.getBoundingClientRect().height);
    }
    return height > 0 ? height : row.getBoundingClientRect().height;
  }

  private measure(): void {
    const table = this.table;
    if (!table) {
      return;
    }
    const body = table.tBodies[0];
    const headerRow = table.tHead?.rows[0];
    const rows = body ? [...body.rows] : [];
    const headerCells = headerRow ? [...headerRow.cells] : [];
    const frozenRows = clamp(Number(table.dataset.frozenRows) || 0, 0, rows.length);
    const frozenColumns = clamp(
      Number(table.dataset.frozenColumns) || 0,
      0,
      Math.max(0, headerCells.length - 1),
    );
    if (rows.length === 0 || headerCells.length < 2 || (!frozenRows && !frozenColumns)) {
      return;
    }
    const headerHeight = Math.max(
      ...headerCells.map((cell) => cell.getBoundingClientRect().height),
    );
    const rowHeaderWidth = headerCells[0]?.getBoundingClientRect().width ?? 0;
    // jsdom and other non-layout environments expose zero boxes; keep the
    // deterministic nominal fallbacks rendered by the sheet view.
    if (headerHeight <= 0 || rowHeaderWidth <= 0) {
      return;
    }

    const columnHeaders = headerCells.slice(1);
    const columnWidths = columnHeaders.map((cell) => cell.getBoundingClientRect().width);
    const rowHeights = rows.slice(0, frozenRows).map((row) => this.rowHeight(row));
    if (rowHeights.some((height) => height <= 0)) {
      return;
    }
    const rowTops = rowHeights.map((_, index) => headerHeight + sum(rowHeights.slice(0, index)));
    const columnLefts = columnWidths.map(
      (_, index) => rowHeaderWidth + sum(columnWidths.slice(0, index)),
    );

    rows.forEach((row, rowIndex) => {
      const rowHeader = row.cells[0];
      const frozenRow = rowIndex < frozenRows;
      if (rowHeader) {
        setPx(rowHeader, "top", frozenRow ? rowTops[rowIndex] : undefined);
      }
      for (let cellIndex = 1; cellIndex < row.cells.length; cellIndex += 1) {
        const cell = row.cells[cellIndex]!;
        const column = Number(cell.dataset.column);
        if (!Number.isFinite(column)) {
          continue;
        }
        setPx(cell, "top", frozenRow ? rowTops[rowIndex] : undefined);
        setPx(cell, "left", column < frozenColumns ? columnLefts[column] : undefined);
      }
    });

    columnHeaders.forEach((header, column) => {
      setPx(header, "left", column < frozenColumns ? columnLefts[column] : undefined);
    });
  }
}
