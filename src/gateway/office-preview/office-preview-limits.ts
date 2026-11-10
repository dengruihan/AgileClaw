/**
 * Bounds for the read-only Office preview reader.
 *
 * Every limit is enforced on the Gateway side before the renderer sees a
 * payload: the archive reader caps entries and inflated bytes, and the parsers
 * cap rendered rows, blocks, slides, and characters. Exceeding a rendering
 * limit truncates the payload; exceeding an archive limit degrades the whole
 * file to the metadata-only preview.
 */

/** Largest workspace file the Gateway will read to build an Office preview. */
export const OFFICE_PREVIEW_MAX_BYTES = 8 * 1024 * 1024;

/** Wall-clock ceiling for one parse task; the pool also aborts it. */
export const OFFICE_PREVIEW_TIMEOUT_MS = 15_000;

export const OFFICE_PREVIEW_MAX_ZIP_ENTRIES = 2_000;
export const OFFICE_PREVIEW_MAX_ZIP_ENTRY_BYTES = 8 * 1024 * 1024;
export const OFFICE_PREVIEW_MAX_ZIP_UNCOMPRESSED_BYTES = 48 * 1024 * 1024;
/** Refuse archives whose inflation ratio looks like a zip bomb. */
export const OFFICE_PREVIEW_MAX_ZIP_COMPRESSION_RATIO = 100;

export const OFFICE_PREVIEW_MAX_SHEETS = 20;
export const OFFICE_PREVIEW_MAX_SHEET_ROWS = 200;
export const OFFICE_PREVIEW_MAX_SHEET_COLUMNS = 40;
export const OFFICE_PREVIEW_MAX_SHEET_CELLS = 20_000;
export const OFFICE_PREVIEW_MAX_CELL_CHARS = 4_096;
export const OFFICE_PREVIEW_MAX_SPREADSHEET_CHARS = 400_000;
export const OFFICE_PREVIEW_MAX_MERGES = 500;

export const OFFICE_PREVIEW_MAX_BLOCKS = 2_000;
export const OFFICE_PREVIEW_MAX_BLOCK_CHARS = 8_000;
export const OFFICE_PREVIEW_MAX_DOCUMENT_CHARS = 400_000;

/** Approximate DOCX page cards; Word can paginate larger documents beyond this. */
export const OFFICE_PREVIEW_MAX_DOCX_PAGES = 50;
export const OFFICE_PREVIEW_MAX_PAGE_BLOCKS = 500;
export const OFFICE_PREVIEW_MAX_DOCX_RUNS = 8_000;
export const OFFICE_PREVIEW_MAX_DOCX_TABLE_CELLS = 4_000;
export const OFFICE_PREVIEW_MAX_DOCX_IMAGES = 24;
/** Per-image decoded bytes; a single embedded photo stays comfortably inline. */
export const OFFICE_PREVIEW_MAX_DOCX_IMAGE_BYTES = 384 * 1024;
/** Total decoded bytes across every inlined document image. */
export const OFFICE_PREVIEW_MAX_DOCX_IMAGE_TOTAL_BYTES = 1024 * 1024;
export const OFFICE_PREVIEW_MAX_DOCX_LIST_LEVELS = 9;

export const OFFICE_PREVIEW_MAX_SLIDES = 100;
export const OFFICE_PREVIEW_MAX_SLIDE_LINES = 80;
export const OFFICE_PREVIEW_MAX_SLIDE_LINE_CHARS = 2_000;
export const OFFICE_PREVIEW_MAX_PRESENTATION_CHARS = 200_000;
