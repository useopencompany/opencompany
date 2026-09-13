import { truncateText } from "../actions/types";

// Shared Google Sheets value bounds and shaping for the two surfaces that talk to the Sheets REST
// API: the connected-action catalog (`actions/google-drive.ts`) and the Drive MCP server
// (`integrations/google-drive-mcp-server.ts`). Parameter validation stays with each surface because
// their idioms differ; only the response shaping and the limits themselves are shared.

export type GoogleSheetCellValue = string | number | boolean | null;

export const MAX_SPREADSHEET_RANGE_CHARS = 500;
export const MAX_SPREADSHEET_READ_ROWS = 1_000;
export const MAX_SPREADSHEET_WRITE_ROWS = 500;
export const MAX_SPREADSHEET_COLUMNS = 100;
export const MAX_SPREADSHEET_CELLS = 10_000;
export const MAX_SPREADSHEET_CELL_CHARS = 5_000;

export function googleSpreadsheetUrl(fileId: string) {
  return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(fileId)}/edit`;
}

// A1 notation quotes a sheet title in single quotes and escapes an embedded quote by doubling it.
export function spreadsheetRangeForSheet(title: string) {
  return `'${title.replaceAll("'", "''")}'`;
}

export function sanitizeSpreadsheetValues(
  value: unknown,
  maxRows: number = MAX_SPREADSHEET_READ_ROWS,
) {
  const rows = Array.isArray(value) ? value : [];
  const values: GoogleSheetCellValue[][] = [];
  let truncated = rows.length > maxRows;
  let cellCount = 0;

  for (const rawRow of rows.slice(0, maxRows)) {
    const row = Array.isArray(rawRow) ? rawRow : [];
    if (row.length > MAX_SPREADSHEET_COLUMNS) truncated = true;
    const shapedRow: GoogleSheetCellValue[] = [];
    for (const rawCell of row.slice(0, MAX_SPREADSHEET_COLUMNS)) {
      if (cellCount >= MAX_SPREADSHEET_CELLS) {
        truncated = true;
        break;
      }
      const cell = sanitizeSpreadsheetCell(rawCell);
      shapedRow.push(cell.value);
      if (cell.truncated) truncated = true;
      cellCount += 1;
    }
    values.push(shapedRow);
    if (cellCount >= MAX_SPREADSHEET_CELLS) break;
  }

  return { values, truncated };
}

function sanitizeSpreadsheetCell(value: unknown): {
  value: GoogleSheetCellValue;
  truncated: boolean;
} {
  if (value === null || typeof value === "boolean") return { value, truncated: false };
  if (typeof value === "number" && Number.isFinite(value)) return { value, truncated: false };
  if (typeof value === "string") {
    return {
      value: truncateText(value, MAX_SPREADSHEET_CELL_CHARS) ?? "",
      truncated: value.length > MAX_SPREADSHEET_CELL_CHARS,
    };
  }
  return { value: null, truncated: true };
}
