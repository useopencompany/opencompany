import ExcelJS from "exceljs";
import mammoth from "mammoth";

const DEFAULT_MAX_BYTES = 200_000;
const MAX_ROWS_PER_SHEET = 2_000;

export type ExtractOptions = {
  // Output is truncated (with a marker) once it exceeds this many UTF-8 bytes.
  maxBytes?: number;
};

export async function extractDocxText(
  bytes: Buffer,
  options: ExtractOptions = {},
): Promise<string> {
  const result = await mammoth.extractRawText({ buffer: bytes });
  return capBytes(result.value.trim(), options.maxBytes ?? DEFAULT_MAX_BYTES);
}

// Renders each sheet as a `## Sheet: <name>` heading followed by CSV rows so
// both the chat model and the ingestion agent get a structure they can quote.
export async function extractXlsxText(
  bytes: Buffer,
  options: ExtractOptions = {},
): Promise<string> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bufferToArrayBuffer(bytes));
  const sections: string[] = [];
  let usedBytes = 0;
  for (const sheet of workbook.worksheets) {
    const lines: string[] = [`## Sheet: ${sheet.name}`];
    let rowCount = 0;
    sheet.eachRow({ includeEmpty: false }, (row) => {
      if (rowCount >= MAX_ROWS_PER_SHEET) return;
      rowCount += 1;
      const values: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell) => {
        values.push(csvEscape(cellText(cell.value)));
      });
      lines.push(values.join(","));
    });
    if (rowCount >= MAX_ROWS_PER_SHEET) {
      lines.push(`… truncated at ${MAX_ROWS_PER_SHEET} rows`);
    }
    const section = lines.join("\n");
    const sectionBytes = Buffer.byteLength(section, "utf8");
    if (usedBytes + sectionBytes > maxBytes) {
      sections.push(capBytes(section, Math.max(0, maxBytes - usedBytes)));
      break;
    }
    sections.push(section);
    usedBytes += sectionBytes + 2;
  }
  return sections.join("\n\n").trim();
}

export function extractUtf8Text(bytes: Buffer, options: ExtractOptions = {}): string {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
  return capBytes(text, options.maxBytes ?? DEFAULT_MAX_BYTES);
}

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    if ("richText" in value) return value.richText.map((run) => run.text).join("");
    if ("text" in value && typeof value.text === "string") return value.text;
    if ("result" in value) return cellText(value.result as ExcelJS.CellValue);
    if ("error" in value) return String(value.error);
    return "";
  }
  return String(value);
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replaceAll('"', '""')}"`;
  return value;
}

function capBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const truncated = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
  // Drop a possibly split trailing code point, then mark the cut.
  return `${truncated.replace(/�+$/, "")}\n… truncated`;
}

function bufferToArrayBuffer(bytes: Buffer): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
