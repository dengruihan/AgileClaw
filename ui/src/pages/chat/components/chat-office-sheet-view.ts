import { html, nothing, type TemplateResult } from "lit";
import { styleMap } from "lit/directives/style-map.js";
import type { SessionFileOfficePreview } from "../../../../../packages/gateway-protocol/src/schema/sessions.js";
import { t } from "../../../i18n/index.ts";
import {
  OFFICE_SHEET_COLUMN_HEADER_PX,
  OFFICE_SHEET_ROW_HEADER_PX,
  officeCellStyle,
  officeSheetColumnWidthPx,
  officeSheetRowHeightPx,
} from "./chat-office-layout-style.ts";

type Sheet = NonNullable<SessionFileOfficePreview["sheets"]>[number];
type Cell = NonNullable<Sheet["cells"]>[number];

type MergeRange = { rowSpan: number; columnSpan: number };
type StickyStyle = { top?: string; left?: string };

const MAX_RENDERED_COLUMNS = 40;

export function officeColumnLetter(index: number): string {
  let value = Math.max(0, Math.floor(index));
  let label = "";
  do {
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);
  return label;
}

function columnCountFor(sheet: Sheet): number {
  const rowWidth = sheet.rows.reduce((max, row) => Math.max(max, row.length), 0);
  const declared = sheet.columns?.length ?? 0;
  return Math.min(MAX_RENDERED_COLUMNS, Math.max(1, rowWidth, declared));
}

function columnWidths(sheet: Sheet, count: number): number[] {
  return Array.from({ length: count }, (_, index) => {
    const column = sheet.columns?.[index];
    return officeSheetColumnWidthPx(column?.width ?? 0, column?.hidden === true);
  });
}

function rowHeights(sheet: Sheet): number[] {
  return sheet.rows.map((_, index) => officeSheetRowHeightPx(sheet.rowHeights?.[index]));
}

function stickyOffsets(sheet: Sheet, widths: number[], heights: number[], count: number) {
  const frozenRows = Math.min(Math.max(0, sheet.frozenRows ?? 0), sheet.rows.length);
  const frozenColumns = Math.min(Math.max(0, sheet.frozenColumns ?? 0), count);
  const frozenRowHeight = heights.slice(0, frozenRows).reduce((sum, height) => sum + height, 0);
  const frozenColumnWidth = widths.slice(0, frozenColumns).reduce((sum, width) => sum + width, 0);
  const rowTop = (index: number) =>
    OFFICE_SHEET_COLUMN_HEADER_PX +
    (index < frozenRows
      ? heights.slice(0, index).reduce((sum, height) => sum + height, 0)
      : frozenRowHeight);
  const columnLeft = (index: number) =>
    OFFICE_SHEET_ROW_HEADER_PX +
    (index < frozenColumns
      ? widths.slice(0, index).reduce((sum, width) => sum + width, 0)
      : frozenColumnWidth);
  return { frozenRows, frozenColumns, rowTop, columnLeft };
}

function mergeState(sheet: Sheet, rows: number, columns: number) {
  const anchors = new Map<string, MergeRange>();
  const covered = new Set<string>();
  for (const merge of sheet.mergedCells ?? []) {
    if (merge.row >= rows || merge.column >= columns) {
      continue;
    }
    const rowEnd = Math.min(rows, merge.row + Math.max(1, merge.rowSpan));
    const columnEnd = Math.min(columns, merge.column + Math.max(1, merge.columnSpan));
    if (rowEnd <= merge.row || columnEnd <= merge.column) {
      continue;
    }
    anchors.set(`${merge.row}:${merge.column}`, {
      rowSpan: rowEnd - merge.row,
      columnSpan: columnEnd - merge.column,
    });
    for (let row = merge.row; row < rowEnd; row += 1) {
      for (let column = merge.column; column < columnEnd; column += 1) {
        if (row !== merge.row || column !== merge.column) {
          covered.add(`${row}:${column}`);
        }
      }
    }
  }
  return { anchors, covered };
}

function cellEntries(sheet: Sheet): Map<string, Cell> {
  return new Map((sheet.cells ?? []).map((cell) => [`${cell.row}:${cell.column}`, cell] as const));
}

function styleForCell(
  sheet: Sheet,
  entries: Map<string, Cell>,
  row: number,
  column: number,
): ReturnType<typeof officeCellStyle> {
  const entry = entries.get(`${row}:${column}`);
  if (entry?.plain === true) {
    return {};
  }
  const styleIndex = entry?.style ?? sheet.defaultStyle;
  const style =
    styleIndex === undefined ? undefined : sheet.styles?.[Math.max(0, Math.min(255, styleIndex))];
  return officeCellStyle(style);
}

function stickyStyle(
  frozenRows: boolean,
  frozenColumns: boolean,
  top: string,
  left: string,
): StickyStyle {
  return {
    ...(frozenRows ? { top } : {}),
    ...(frozenColumns ? { left } : {}),
  };
}

function renderCell(params: {
  sheet: Sheet;
  value: string;
  row: number;
  column: number;
  entries: Map<string, Cell>;
  merge: MergeRange | undefined;
  frozenRows: boolean;
  frozenColumns: boolean;
  top: string;
  left: string;
  hidden: boolean;
}): TemplateResult {
  const classes = ["sidebar-office-sheet__cell"];
  if (params.frozenRows) {
    classes.push("sidebar-office-sheet__cell--frozen-row");
  }
  if (params.frozenColumns) {
    classes.push("sidebar-office-sheet__cell--frozen-column");
  }
  if (params.frozenRows && params.frozenColumns) {
    classes.push("sidebar-office-sheet__cell--frozen-corner");
  }
  if (params.hidden) {
    classes.push("sidebar-office-sheet__cell--hidden");
  }
  return html`<td
    class=${classes.join(" ")}
    colspan=${params.merge && params.merge.columnSpan > 1 ? params.merge.columnSpan : nothing}
    rowspan=${params.merge && params.merge.rowSpan > 1 ? params.merge.rowSpan : nothing}
    data-row=${params.row}
    data-column=${params.column}
    style=${styleMap({
      ...styleForCell(params.sheet, params.entries, params.row, params.column),
      ...stickyStyle(params.frozenRows, params.frozenColumns, params.top, params.left),
    })}
  >
    ${params.value}
  </td>`;
}

function renderRow(params: {
  sheet: Sheet;
  row: string[];
  index: number;
  columns: number;
  heights: number[];
  entries: Map<string, Cell>;
  merges: ReturnType<typeof mergeState>;
  frozenRows: number;
  frozenColumns: number;
  rowTop: (index: number) => number;
  columnLeft: (index: number) => number;
}): TemplateResult {
  const frozenRow = params.index < params.frozenRows;
  const rowNumber = params.sheet.rowNumbers?.[params.index] ?? params.index + 1;
  const cells: TemplateResult[] = [];
  for (let column = 0; column < params.columns; column += 1) {
    if (params.merges.covered.has(`${params.index}:${column}`)) {
      continue;
    }
    cells.push(
      renderCell({
        sheet: params.sheet,
        value: params.row[column] ?? "",
        row: params.index,
        column,
        entries: params.entries,
        merge: params.merges.anchors.get(`${params.index}:${column}`),
        frozenRows: frozenRow,
        frozenColumns: column < params.frozenColumns,
        top: `${params.rowTop(params.index)}px`,
        left: `${params.columnLeft(column)}px`,
        hidden: params.sheet.columns?.[column]?.hidden === true,
      }),
    );
  }
  return html`<tr
    data-row-index=${params.index}
    style=${styleMap({ height: `${params.heights[params.index]}px` })}
  >
    <th
      class="sidebar-office-sheet__row-header ${
        frozenRow ? "sidebar-office-sheet__row-header--frozen" : ""
      }"
      scope="row"
      style=${styleMap(frozenRow ? { top: `${params.rowTop(params.index)}px` } : {})}
    >
      ${rowNumber}
    </th>
    ${cells}
  </tr>`;
}

function renderSheet(sheet: Sheet): TemplateResult {
  const columns = columnCountFor(sheet);
  const widths = columnWidths(sheet, columns);
  const heights = rowHeights(sheet);
  const { frozenRows, frozenColumns, rowTop, columnLeft } = stickyOffsets(
    sheet,
    widths,
    heights,
    columns,
  );
  const merges = mergeState(sheet, sheet.rows.length, columns);
  const entries = cellEntries(sheet);
  return html`<div class="sidebar-office-sheet__scroll" data-sheet-name=${sheet.name}>
    <table
      class="sidebar-office-sheet__table ${
        sheet.showGridLines === false ? "" : "sidebar-office-sheet__table--gridlines"
      }"
      data-frozen-rows=${frozenRows}
      data-frozen-columns=${frozenColumns}
      aria-label=${sheet.name || t("chat.officePreview.untitledSheet")}
    >
      <colgroup>
        <col style=${styleMap({ width: `${OFFICE_SHEET_ROW_HEADER_PX}px` })} />
        ${widths.map((width) => html`<col style=${styleMap({ width: `${width}px` })} />`)}
      </colgroup>
      <thead>
        <tr>
          <th class="sidebar-office-sheet__corner" scope="col" aria-hidden="true"></th>
          ${widths.map(
            (_, column) => html`<th
              class="sidebar-office-sheet__column-header ${
                column < frozenColumns ? "sidebar-office-sheet__column-header--frozen" : ""
              }"
              scope="col"
              data-column=${column}
              style=${styleMap(column < frozenColumns ? { left: `${columnLeft(column)}px` } : {})}
            >
              ${officeColumnLetter(column)}
            </th>`,
          )}
        </tr>
      </thead>
      <tbody>
        ${sheet.rows.map((row, index) =>
          renderRow({
            sheet,
            row,
            index,
            columns,
            heights,
            entries,
            merges,
            frozenRows,
            frozenColumns,
            rowTop,
            columnLeft,
          }),
        )}
      </tbody>
    </table>
  </div>`;
}

/** Workbook tabs and the active worksheet grid. Sheet switching stays local. */
export function renderWorkbook(
  preview: SessionFileOfficePreview,
  selectedSheet: number,
  onSelectSheet: (index: number) => void,
): TemplateResult {
  // Hidden worksheets keep their payload declaration but are not switchable
  // or rendered, matching the workbook tab contract.
  const sheets = (preview.sheets ?? []).filter((entry) => entry.hidden !== true);
  const activeIndex = Math.min(Math.max(0, selectedSheet), Math.max(0, sheets.length - 1));
  const sheet = sheets[activeIndex];
  return html`
    ${
      sheets.length > 1
        ? html`<div
            class="sidebar-office-preview__tabs"
            role="tablist"
            aria-label=${t("chat.officePreview.sheetPicker")}
          >
            ${sheets.map(
              (entry, index) => html`<button
                class="sidebar-office-preview__tab"
                type="button"
                role="tab"
                aria-selected=${index === activeIndex ? "true" : "false"}
                @click=${() => onSelectSheet(index)}
              >
                ${entry.name || t("chat.officePreview.untitledSheet")}
              </button>`,
            )}
          </div>`
        : nothing
    }
    ${
      !sheet || sheet.rows.length === 0
        ? html`<div class="sidebar-office-preview__empty">${t("chat.officePreview.empty")}</div>`
        : renderSheet(sheet)
    }
  `;
}
