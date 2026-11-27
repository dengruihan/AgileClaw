/** Bottom space kept free on every page card so rounding never paints over a page. */
const PAGE_FIT_SAFETY_PX = 6;
/** Flex gap between block boxes inside one page body; mirrors the stylesheet. */
export const OFFICE_DOCX_BLOCK_GAP_PX = 2;

/** Measured size of one document block on the fixed canvas. */
export type OfficeDocxBlockMetrics = {
  /** Outer height in unscaled canvas pixels, margins included. */
  height: number;
  /** Row heights when the block is a table that may continue on the next page. */
  rowHeights?: readonly number[];
};

/** Measured page card: printable body height plus its declared canvas height. */
export type OfficeDocxPageMetrics = {
  capacity: number;
  height: number;
  blocks: readonly OfficeDocxBlockMetrics[];
};

/** One block box placed on a card; `rows` narrows a continued table. */
export type OfficeDocxSlice = {
  block: number;
  rows: readonly [number, number] | null;
  height: number;
};

/** One physical page card of the fixed canvas. */
export type OfficeDocxPageLayout = {
  /** Declared page this card starts, continues, or completes. */
  source: number;
  slices: readonly OfficeDocxSlice[];
  /** Canvas height in unscaled pixels; only a single oversized unit grows it. */
  height: number;
};

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/**
 * Distribute declared pages over fixed-height cards.
 *
 * Blocks stay atomic unless they are tables, which continue row by row so a
 * long table never clips or silently disappears. A single unit taller than one
 * page keeps its own card and grows that card instead of hiding the overflow.
 */
export function paginateOfficeDocxPages(
  pages: readonly OfficeDocxPageMetrics[],
): OfficeDocxPageLayout[] {
  const layout: OfficeDocxPageLayout[] = [];
  pages.forEach((page, source) => {
    const capacity = page.capacity - PAGE_FIT_SAFETY_PX;
    const cards: OfficeDocxSlice[][] = [];
    let current: OfficeDocxSlice[] = [];
    let used = 0;

    const flush = (): void => {
      if (current.length > 0) {
        cards.push(current);
        current = [];
        used = 0;
      }
    };
    const available = (): number =>
      capacity - (current.length === 0 ? 0 : used + OFFICE_DOCX_BLOCK_GAP_PX);
    const push = (slice: OfficeDocxSlice): void => {
      used = current.length === 0 ? slice.height : used + OFFICE_DOCX_BLOCK_GAP_PX + slice.height;
      current.push(slice);
    };

    if (capacity <= 0) {
      // A page whose margins leave no room cannot be paginated; keep every
      // block on its declared card so nothing is dropped.
      layout.push({
        source,
        height: page.height,
        slices: page.blocks.map((block, index) => ({
          block: index,
          rows: null,
          height: block.height,
        })),
      });
      return;
    }

    page.blocks.forEach((block, index) => {
      const rows = block.rowHeights;
      if (!rows || rows.length === 0) {
        if (block.height > available() && current.length > 0) {
          flush();
        }
        push({ block: index, rows: null, height: block.height });
        return;
      }
      // Border and margin pixels belong to the table box, not to its rows, so
      // every row fragment pays them once.
      const overhead = Math.max(0, block.height - sum(rows));
      let start = 0;
      while (start < rows.length) {
        const room = available();
        let end = start;
        let height = overhead;
        while (end < rows.length) {
          const next = height + rows[end]!;
          if (end > start && next > room) {
            break;
          }
          height = next;
          end += 1;
        }
        if (height > room && current.length > 0) {
          flush();
          continue;
        }
        push({ block: index, rows: [start, end], height });
        start = end;
      }
    });
    flush();
    if (cards.length === 0) {
      cards.push([]);
    }
    cards.forEach((slices) => {
      const needed =
        sum(slices.map((slice) => slice.height)) +
        OFFICE_DOCX_BLOCK_GAP_PX * Math.max(0, slices.length - 1);
      layout.push({
        source,
        slices,
        height: Math.ceil(page.height + Math.max(0, needed - capacity)),
      });
    });
  });
  return layout;
}

/**
 * Fractional layout sizes are read from rects (the measuring stage is untransformed)
 * and rounded up, so the pagination never under-books a line it must fit.
 */
function measureBlock(element: HTMLElement): OfficeDocxBlockMetrics {
  const style = getComputedStyle(element);
  const margins =
    Math.max(0, Number.parseFloat(style.marginTop) || 0) +
    Math.max(0, Number.parseFloat(style.marginBottom) || 0);
  const height = Math.ceil(element.getBoundingClientRect().height + margins);
  if (element.classList.contains("sidebar-office-docx__table")) {
    const rows = [...element.querySelectorAll<HTMLElement>("tbody tr")].map((row) =>
      Math.ceil(row.getBoundingClientRect().height),
    );
    if (rows.length > 0 && rows.every((row) => row > 0)) {
      return { height, rowHeights: rows };
    }
  }
  return { height };
}

/**
 * Read the hidden measuring stage and return the real page distribution.
 * Returns `null` when no layout is available (jsdom or before first paint),
 * leaving the declared pages in place.
 */
export function measureOfficeDocxPages(root: ParentNode): OfficeDocxPageLayout[] | null {
  const cards = [...root.querySelectorAll<HTMLElement>("[data-office-docx-measure]")];
  if (cards.length === 0) {
    return null;
  }
  const metrics: OfficeDocxPageMetrics[] = [];
  let measurable = 0;
  for (const card of cards) {
    const body = card.querySelector<HTMLElement>(".sidebar-office-docx__page-body");
    const blocks = body
      ? [...body.children].map((child) => measureBlock(child as HTMLElement))
      : [];
    const capacity = Math.floor(body?.getBoundingClientRect().height ?? 0);
    const height = Math.round(card.getBoundingClientRect().height);
    // A hidden reader (display:none) yields no boxes; that page keeps its
    // declared card instead of failing the whole document.
    const usable = Boolean(body) && capacity > 0 && height > 0;
    if (usable) {
      measurable += 1;
    }
    metrics.push({
      capacity: usable ? capacity : 0,
      height: usable ? height : declaredPageHeight(card),
      blocks,
    });
  }
  if (measurable === 0) {
    return null;
  }
  return paginateOfficeDocxPages(metrics);
}

/** Declared card height from the inline canvas variable, for unmeasurable pages. */
function declaredPageHeight(card: HTMLElement): number {
  const declared = Number.parseFloat(card.style.getPropertyValue("--office-doc-page-height"));
  return Number.isFinite(declared) && declared > 0 ? Math.round(declared) : 1_123;
}
