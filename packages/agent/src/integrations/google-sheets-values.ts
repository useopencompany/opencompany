import { truncateText } from "../actions/types";

// Shared Google Sheets value bounds and shaping for the two surfaces that talk to the Sheets REST
// API: the connected-action catalog (`actions/google-drive.ts`) and the Drive MCP server
// (`integrations/google-drive-mcp-server.ts`). Parameter validation stays with each surface because
// their idioms differ; only the response shaping and the limits themselves are shared.
//
// Sheets returns and accepts a 2D array whose outer entries follow `majorDimension`: rows by
// default, columns when asked. These bounds are therefore named per "line" — one entry along the
// major dimension — so they never assume an axis. The aggregate cell and character caps are what
// actually protect the response; the per-line caps only stop a pathological single line.

export type GoogleSheetCellValue = string | number | boolean | null;

export const MAX_SPREADSHEET_RANGE_CHARS = 500;
export const MAX_SPREADSHEET_READ_LINES = 1_000;
export const MAX_SPREADSHEET_WRITE_LINES = 500;
export const MAX_SPREADSHEET_CELLS = 10_000;
export const MAX_SPREADSHEET_CELL_CHARS = 5_000;
// Matches the Markdown cap the Drive MCP's other read tool uses, so no single tool result can
// dominate a model's context.
export const MAX_SPREADSHEET_OUTPUT_CHARS = 200_000;

export function googleSpreadsheetUrl(fileId: string) {
  return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(fileId)}/edit`;
}

// A1 notation quotes a sheet title in single quotes and escapes an embedded quote by doubling it.
export function spreadsheetRangeForSheet(title: string) {
  return `'${title.replaceAll("'", "''")}'`;
}

export function sanitizeSpreadsheetValues(value: unknown) {
  const lines = Array.isArray(value) ? value : [];
  const values: GoogleSheetCellValue[][] = [];
  let truncated = lines.length > MAX_SPREADSHEET_READ_LINES;
  let cellCount = 0;
  let charCount = 0;

  for (const rawLine of lines.slice(0, MAX_SPREADSHEET_READ_LINES)) {
    const line = Array.isArray(rawLine) ? rawLine : [];
    const shapedLine: GoogleSheetCellValue[] = [];
    for (const rawCell of line) {
      if (cellCount >= MAX_SPREADSHEET_CELLS || charCount >= MAX_SPREADSHEET_OUTPUT_CHARS) {
        truncated = true;
        break;
      }
      const cell = sanitizeSpreadsheetCell(rawCell);
      shapedLine.push(cell.value);
      if (cell.truncated) truncated = true;
      cellCount += 1;
      charCount += typeof cell.value === "string" ? cell.value.length : 8;
    }
    values.push(shapedLine);
    if (cellCount >= MAX_SPREADSHEET_CELLS || charCount >= MAX_SPREADSHEET_OUTPUT_CHARS) {
      if (values.length < lines.length) truncated = true;
      break;
    }
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
